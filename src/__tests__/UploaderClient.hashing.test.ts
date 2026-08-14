/**
 * Checksum computation across the streaming threshold.
 *
 * The unit tests in `sha256.test.ts` prove the incremental hasher agrees
 * with WebCrypto. These prove the *client* picks between the two without
 * changing what it sends: the digest becomes the `.pending/<upload_id>`
 * path and the value the daemon compares against, so a mismatch between
 * the two paths would fail every large upload after transferring it.
 *
 * Deliberately no crypto stub here — the real digest is the oracle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkUploadError } from "../errors";
import { UploaderClient } from "../UploaderClient";
import {
  MockXHR,
  bytesToBase64,
  installFetchStub,
  makeFile,
  tick,
  toBase64Url,
} from "./testUtils";

const UPLOAD_URL = "/api/uploads/{upload_id}/chunk";
const FINISH_URL = "/api/uploads/{upload_id}/finish";

/** Deterministic bytes — a failure here has to be replayable. */
function pseudoRandom(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

async function realHashBase64(bytes: Uint8Array): Promise<string> {
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}

/**
 * Run one single-chunk upload to completion and return its upload_id.
 *
 * `MockXHR.instances` accumulates for the lifetime of the install, so this
 * snapshots the count first and completes *its own* request rather than
 * `last()` — otherwise a second upload in the same test would try to finish
 * the first one's already-settled XHR and hang forever.
 */
async function runUpload(
  client: UploaderClient,
  file: File,
): Promise<string> {
  const before = MockXHR.instances.length;
  const p = client.upload(file, -1);
  await MockXHR.waitForCount(before + 1);
  MockXHR.instances[before].finishOK(200);
  return p;
}

describe("UploaderClient checksum", () => {
  let restoreXhr: () => void;

  beforeEach(() => {
    restoreXhr = MockXHR.install();
  });

  afterEach(() => {
    restoreXhr();
    vi.restoreAllMocks();
  });

  describe("threshold equivalence", () => {
    it("produces the same upload_id whether it streams or not", async () => {
      const bytes = pseudoRandom(5000, 31);
      const expected = await realHashBase64(bytes);

      const ids: string[] = [];
      for (const threshold of [
        // Above the file size → whole-file WebCrypto path.
        10_000,
        // Below it → incremental path, in many small slices.
        1_000,
      ]) {
        const fetchStub = installFetchStub();
        fetchStub.queue.push({
          status: 200,
          body: { hash: expected, length: bytes.length },
        });

        const client = new UploaderClient({
          endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
          hashStreamingThresholdBytes: threshold,
          hashSliceBytes: 512,
        });

        ids.push(await runUpload(client, makeFile(bytes)));
      }

      expect(ids[0]).toBe(toBase64Url(expected));
      expect(ids[1]).toBe(ids[0]);
    });

    it("streams correctly when the file is not a multiple of the slice size", async () => {
      // 4097 over 1024-byte slices leaves a 1-byte final slice — the case
      // where an off-by-one in the tail handling would show up.
      const bytes = pseudoRandom(4097, 37);
      const expected = await realHashBase64(bytes);

      const fetchStub = installFetchStub();
      fetchStub.queue.push({
        status: 200,
        body: { hash: expected, length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        hashStreamingThresholdBytes: 1,
        hashSliceBytes: 1024,
      });

      await expect(runUpload(client, makeFile(bytes))).resolves.toBe(
        toBase64Url(expected),
      );
    });

    it("hashes an empty file identically on both paths", async () => {
      const bytes = new Uint8Array(0);
      const expected = await realHashBase64(bytes);

      const fetchStub = installFetchStub();
      fetchStub.queue.push({ status: 200, body: { hash: expected, length: 0 } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        // A zero-byte file can never exceed the threshold, so this is the
        // WebCrypto path — but it pins that an empty file is not special-cased
        // into a wrong digest.
        hashStreamingThresholdBytes: 1,
      });

      await expect(runUpload(client, makeFile(bytes))).resolves.toBe(
        toBase64Url(expected),
      );
    });
  });

  describe("memory behaviour", () => {
    it("never reads the whole file when streaming", async () => {
      // The entire point: `file.arrayBuffer()` on a multi-GB upload is the
      // allocation that kills the tab.
      const bytes = pseudoRandom(4096, 41);
      const expected = await realHashBase64(bytes);
      const file = makeFile(bytes);

      const wholeFileRead = vi.fn(async () => {
        throw new Error("read the whole file");
      });
      Object.defineProperty(file, "arrayBuffer", {
        value: wholeFileRead,
        configurable: true,
      });

      const fetchStub = installFetchStub();
      fetchStub.queue.push({
        status: 200,
        body: { hash: expected, length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        hashStreamingThresholdBytes: 1024,
        hashSliceBytes: 512,
      });

      await expect(runUpload(client, file)).resolves.toBe(
        toBase64Url(expected),
      );
      expect(wholeFileRead).not.toHaveBeenCalled();
    });

    it("uses WebCrypto below the threshold", async () => {
      const bytes = pseudoRandom(100, 43);
      const expected = await realHashBase64(bytes);
      const file = makeFile(bytes);

      const digestSpy = vi.spyOn(crypto.subtle, "digest");

      const fetchStub = installFetchStub();
      fetchStub.queue.push({
        status: 200,
        body: { hash: expected, length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        hashStreamingThresholdBytes: 1024,
      });

      await runUpload(client, file);
      expect(digestSpy).toHaveBeenCalledTimes(1);
    });

    it("treats a threshold of 0 as 'always use WebCrypto'", async () => {
      const bytes = pseudoRandom(4096, 47);
      const expected = await realHashBase64(bytes);
      const file = makeFile(bytes);

      const digestSpy = vi.spyOn(crypto.subtle, "digest");

      const fetchStub = installFetchStub();
      fetchStub.queue.push({
        status: 200,
        body: { hash: expected, length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        hashStreamingThresholdBytes: 0,
      });

      await runUpload(client, file);
      expect(digestSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("abort during hashing", () => {
    it("stops reading slices as soon as the caller aborts", async () => {
      const bytes = pseudoRandom(20, 53);
      const file = makeFile(bytes);

      // Resolve each slice on a macrotask so the hashing loop yields between
      // slices and an abort can actually land mid-file.
      let slicesRead = 0;
      Object.defineProperty(file, "slice", {
        value: (start = 0, end = bytes.length) => ({
          arrayBuffer: async () => {
            slicesRead++;
            await tick(1);
            const buf = new ArrayBuffer(end - start);
            new Uint8Array(buf).set(bytes.subarray(start, end));
            return buf;
          },
        }),
        configurable: true,
      });

      installFetchStub();
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        hashStreamingThresholdBytes: 1,
        hashSliceBytes: 1,
      });

      const p = client.upload(file, -1);
      await tick(5);
      client.abort();

      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ChunkUploadError);
      expect((err as ChunkUploadError).kind).toBe("abort");
      expect((err as ChunkUploadError).retryable).toBe(false);
      // Aborted partway, not after grinding through all 20 slices.
      expect(slicesRead).toBeLessThan(bytes.length);
      // And it never got as far as opening a request.
      expect(MockXHR.instances.length).toBe(0);
    });
  });
});
