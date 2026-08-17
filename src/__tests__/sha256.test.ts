/**
 * The incremental SHA-256 is checked against the platform's own WebCrypto
 * implementation rather than against a fixed list of digests. A hash that is
 * subtly wrong would fail every upload at the server-side checksum compare,
 * so "matches BoringSSL on arbitrary input, fed in arbitrary slices" is the
 * property that actually matters — not a handful of vectors.
 *
 * This file deliberately does NOT install the crypto stub the other suites
 * use: it needs the real digest as the oracle.
 */

import { describe, expect, it } from "vitest";
import { Sha256, sha256 } from "../helpers/sha256";

const BLOCK = 64;

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

async function referenceHex(data: Uint8Array): Promise<string> {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copy)));
}

/**
 * Deterministic pseudo-random bytes (32-bit LCG). Reproducible on failure —
 * a flaky crypto test that cannot be replayed is worse than no test.
 */
function pseudoRandom(length: number, seed: number): Uint8Array {
    const out = new Uint8Array(length);
    let state = seed >>> 0;
    for (let i = 0; i < length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        out[i] = (state >>> 24) & 0xff;
    }
    return out;
}

describe("Sha256", () => {
    describe("known vectors (FIPS 180-2)", () => {
        it("hashes the empty message", () => {
            expect(toHex(sha256(new Uint8Array(0)))).toBe(
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            );
        });

        it('hashes "abc"', () => {
            expect(toHex(sha256(new TextEncoder().encode("abc")))).toBe(
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            );
        });

        it("hashes the 448-bit two-block message", () => {
            const message =
                "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
            expect(toHex(sha256(new TextEncoder().encode(message)))).toBe(
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            );
        });

        it("hashes one million 'a' characters", () => {
            const hasher = new Sha256();
            const chunk = new Uint8Array(1000).fill(0x61);
            for (let i = 0; i < 1000; i++) {
                hasher.update(chunk);
            }
            expect(toHex(hasher.digest())).toBe(
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
            );
        });
    });

    describe("agreement with WebCrypto", () => {
        // Padding is the classic place to get SHA-256 wrong: the message
        // length has to land in the last 8 bytes of a block, so 55/56/57 and
        // 119/120/121 exercise the "does the length fit in this block"
        // branch from both sides.
        const boundaries = [
            0, 1, 2, 55, 56, 57, 63, 64, 65, 111, 112, 113, 119, 120, 127, 128,
            129, 191, 192, 255, 256, 257,
        ];

        it.each(boundaries)("matches for a %i-byte message", async (length) => {
            const data = pseudoRandom(length, length + 1);
            expect(toHex(sha256(data))).toBe(await referenceHex(data));
        });

        it("matches for 200 arbitrary lengths", async () => {
            for (let seed = 1; seed <= 200; seed++) {
                const length = (Math.imul(seed, 7919) >>> 0) % 4096;
                const data = pseudoRandom(length, seed);
                const expected = await referenceHex(data);
                expect({ length, hex: toHex(sha256(data)) }).toEqual({
                    length,
                    hex: expected,
                });
            }
        });

        it("matches for a multi-megabyte message", async () => {
            const data = pseudoRandom(5 * 1024 * 1024 + 37, 4242);
            expect(toHex(sha256(data))).toBe(await referenceHex(data));
        });
    });

    describe("slicing invariance", () => {
        // The whole point of the incremental API: however the caller carves
        // the message up, the digest must not change. This is what makes it
        // safe to hash a file slice by slice instead of loading it whole.
        it("is unaffected by how the message is split", async () => {
            const data = pseudoRandom(3000, 7);
            const expected = await referenceHex(data);

            const splittings: number[][] = [
                [3000],
                [1, 2999],
                [BLOCK, 3000 - BLOCK],
                [BLOCK - 1, 1, 3000 - BLOCK],
                [1, 1, 1, 2997],
                [999, 1, 1000, 1000],
                [1500, 1500],
            ];

            for (const sizes of splittings) {
                const hasher = new Sha256();
                let offset = 0;
                for (const size of sizes) {
                    hasher.update(data.subarray(offset, offset + size));
                    offset += size;
                }
                expect({ sizes, hex: toHex(hasher.digest()) }).toEqual({
                    sizes,
                    hex: expected,
                });
            }
        });

        it("tolerates empty updates anywhere in the stream", async () => {
            const data = pseudoRandom(200, 11);
            const hasher = new Sha256();
            hasher.update(new Uint8Array(0));
            hasher.update(data.subarray(0, 100));
            hasher.update(new Uint8Array(0));
            hasher.update(data.subarray(100));
            hasher.update(new Uint8Array(0));

            expect(toHex(hasher.digest())).toBe(await referenceHex(data));
        });

        it("matches when fed in 1-byte updates across a block boundary", async () => {
            const data = pseudoRandom(BLOCK * 2 + 5, 13);
            const hasher = new Sha256();
            for (let i = 0; i < data.length; i++) {
                hasher.update(data.subarray(i, i + 1));
            }
            expect(toHex(hasher.digest())).toBe(await referenceHex(data));
        });

        it("does not read past the end of a subarray view", async () => {
            // `update` compresses whole blocks straight out of the caller's
            // buffer. A view into a larger backing store must not leak the
            // bytes beyond it.
            const backing = pseudoRandom(500, 17);
            const view = backing.subarray(64, 192);
            expect(toHex(sha256(view))).toBe(await referenceHex(view));
        });
    });

    describe("lifecycle", () => {
        it("returns the same digest on repeated calls", () => {
            const hasher = new Sha256().update(new TextEncoder().encode("abc"));
            const first = hasher.digest();
            expect(toHex(hasher.digest())).toBe(toHex(first));
        });

        it("refuses further updates once finalised", () => {
            const hasher = new Sha256().update(new Uint8Array([1]));
            hasher.digest();
            expect(() => hasher.update(new Uint8Array([2]))).toThrow(
                /after digest/,
            );
        });

        it("keeps instances independent", async () => {
            const a = pseudoRandom(100, 19);
            const b = pseudoRandom(100, 23);
            const ha = new Sha256().update(a);
            const hb = new Sha256().update(b);
            expect(toHex(ha.digest())).toBe(await referenceHex(a));
            expect(toHex(hb.digest())).toBe(await referenceHex(b));
        });
    });
});
