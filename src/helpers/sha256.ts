/**
 * Incremental SHA-256 (FIPS 180-4).
 *
 * WebCrypto's `crypto.subtle.digest` is one-shot: it needs the entire message
 * in memory at once. For a multi-gigabyte upload that means a `file
 * .arrayBuffer()` the size of the file — a renderer OOM on the exact files
 * users care most about not losing, and a blocker for uploading several
 * files concurrently (each in-flight file would multiply it).
 *
 * There is no streaming digest in WebCrypto, so this is the alternative:
 * feed the hash slice by slice and keep only one slice resident.
 *
 * `crypto.subtle` remains the default for files below the streaming
 * threshold — it is backed by BoringSSL and is meaningfully faster than any
 * JS implementation. This code only runs where the memory saving is worth
 * the slower hashing, and `sha256.test.ts` pins it against the platform's
 * own implementation over random inputs and every padding boundary.
 */


/** Round constants: first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value: first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;
const DIGEST_BYTES = 32;

/** 2^29 — dividing a byte count by this yields the high word of its bit count. */
const BYTES_PER_HIGH_BIT_WORD = 0x20000000;

export class Sha256 {
    private readonly h = H0.slice();
    private readonly block = new Uint8Array(BLOCK_BYTES);
    private readonly w = new Uint32Array(64);
    private blockLength = 0;
    private bytesHashed = 0;
    private result: Uint8Array | null = null;

    /** Absorb more of the message. Any slicing of the input is equivalent. */
    update(data: Uint8Array): this {
        if (this.result) {
            throw new Error("Sha256: update() called after digest()");
        }

        this.bytesHashed += data.length;
        let offset = 0;

        // Top up a partially filled block from the previous update.
        if (this.blockLength > 0) {
            const take = Math.min(BLOCK_BYTES - this.blockLength, data.length);
            this.block.set(data.subarray(0, take), this.blockLength);
            this.blockLength += take;
            offset = take;

            if (this.blockLength === BLOCK_BYTES) {
                this.compress(this.block, 0);
                this.blockLength = 0;
            }
        }

        // Compress whole blocks straight out of the caller's buffer — no copy.
        while (data.length - offset >= BLOCK_BYTES) {
            this.compress(data, offset);
            offset += BLOCK_BYTES;
        }

        // Carry the tail over to the next update.
        if (offset < data.length) {
            this.block.set(data.subarray(offset), 0);
            this.blockLength = data.length - offset;
        }

        return this;
    }

    /** Finalise and return the 32-byte digest. Idempotent; blocks further updates. */
    digest(): Uint8Array {
        if (!this.result) {
            // Capture the length BEFORE absorbing the padding — the padding
            // itself is not part of the message.
            const messageBytes = this.bytesHashed;

            // Pad to leave exactly 8 bytes for the length at the end of a block.
            const padLength =
                this.blockLength < 56
                    ? 56 - this.blockLength
                    : 120 - this.blockLength;
            const padding = new Uint8Array(padLength + 8);
            padding[0] = 0x80;

            // Message length in BITS, big-endian, as two 32-bit words. Split
            // this way rather than via a 64-bit multiply so it stays exact:
            // bits = bytes * 8, so the high word is bytes / 2^29.
            const view = new DataView(padding.buffer);
            view.setUint32(
                padLength,
                Math.floor(messageBytes / BYTES_PER_HIGH_BIT_WORD) >>> 0,
                false,
            );
            view.setUint32(padLength + 4, (messageBytes * 8) >>> 0, false);

            this.update(padding);

            const out = new Uint8Array(DIGEST_BYTES);
            const outView = new DataView(out.buffer);
            for (let i = 0; i < 8; i++) {
                outView.setUint32(i * 4, this.h[i], false);
            }
            this.result = out;
        }

        return this.result;
    }

    private compress(buf: Uint8Array, offset: number): void {
        const { w } = this;

        for (let i = 0; i < 16; i++) {
            const j = offset + i * 4;
            w[i] =
                ((buf[j] << 24) |
                    (buf[j + 1] << 16) |
                    (buf[j + 2] << 8) |
                    buf[j + 3]) >>>
                0;
        }

        for (let i = 16; i < 64; i++) {
            const x = w[i - 15];
            const y = w[i - 2];
            const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
            const s1 =
                ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        let a = this.h[0];
        let b = this.h[1];
        let c = this.h[2];
        let d = this.h[3];
        let e = this.h[4];
        let f = this.h[5];
        let g = this.h[6];
        let hh = this.h[7];

        for (let i = 0; i < 64; i++) {
            const S1 =
                ((e >>> 6) | (e << 26)) ^
                ((e >>> 11) | (e << 21)) ^
                ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;

            const S0 =
                ((a >>> 2) | (a << 30)) ^
                ((a >>> 13) | (a << 19)) ^
                ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;

            hh = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }

        this.h[0] = (this.h[0] + a) | 0;
        this.h[1] = (this.h[1] + b) | 0;
        this.h[2] = (this.h[2] + c) | 0;
        this.h[3] = (this.h[3] + d) | 0;
        this.h[4] = (this.h[4] + e) | 0;
        this.h[5] = (this.h[5] + f) | 0;
        this.h[6] = (this.h[6] + g) | 0;
        this.h[7] = (this.h[7] + hh) | 0;
    }
}

/** One-shot convenience wrapper. */
export function sha256(data: Uint8Array): Uint8Array {
    return new Sha256().update(data).digest();
}
