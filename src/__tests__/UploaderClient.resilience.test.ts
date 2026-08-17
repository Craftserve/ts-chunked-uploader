/**
 * Resilience behaviour: typed failures, retry classification, and the two
 * timeout budgets.
 *
 * These cover the guarantees that keep an upload from either hanging
 * forever (no timeouts at all) or grinding through 90 seconds of pointless
 * retries on a failure that will never succeed (a full disk classified as
 * a generic 5xx).
 *
 * Every test drives the promise to settlement before returning. A dangling
 * upload leaks its retry timer into the next test and steals the fetch
 * response that test queued — the failure mode looks like an unrelated
 * assertion breaking, so it is worth the extra `await`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChunkUploadError, isRetryableStatus } from "../errors";
import { UploaderClient } from "../UploaderClient";
import { ChunkRetryInfo } from "../types";
import {
  MockXHR,
  expectedHashForFile,
  installCryptoStub,
  installFetchStub,
  makeFile,
  tick,
} from "./testUtils";

const UPLOAD_URL = "/api/uploads/{upload_id}/chunk";
const FINISH_URL = "/api/uploads/{upload_id}/finish";

/** Tiny file, single chunk — these tests are about control flow, not bytes. */
function tinyFile(fill = 1, size = 4) {
  const bytes = new Uint8Array(size).fill(fill);
  return {
    file: makeFile(bytes),
    hash: expectedHashForFile(size, size > 0 ? fill : 0),
    size,
  };
}

describe("UploaderClient resilience", () => {
  let restoreXhr: () => void;
  let restoreCrypto: () => void;

  beforeEach(() => {
    restoreXhr = MockXHR.install();
    restoreCrypto = installCryptoStub();
  });

  afterEach(() => {
    restoreXhr();
    restoreCrypto();
    vi.restoreAllMocks();
  });

  // ---------- Status classification ----------

  describe("isRetryableStatus", () => {
    it("retries transient server failures", () => {
      expect(isRetryableStatus(500)).toBe(true);
      expect(isRetryableStatus(502)).toBe(true);
      expect(isRetryableStatus(503)).toBe(true);
      expect(isRetryableStatus(504)).toBe(true);
    });

    it("does not retry client errors", () => {
      expect(isRetryableStatus(400)).toBe(false);
      expect(isRetryableStatus(401)).toBe(false);
      expect(isRetryableStatus(403)).toBe(false);
      expect(isRetryableStatus(404)).toBe(false);
      expect(isRetryableStatus(409)).toBe(false);
    });

    it("does not retry a full volume (507) or an unimplemented call (501)", () => {
      expect(isRetryableStatus(507)).toBe(false);
      expect(isRetryableStatus(501)).toBe(false);
    });

    it("retries the two 4xx statuses that ask to be retried", () => {
      expect(isRetryableStatus(408)).toBe(true);
      expect(isRetryableStatus(429)).toBe(true);
    });
  });

  // ---------- Typed chunk failures ----------

  describe("typed chunk failures", () => {
    it("carries status, kind and retry verdict instead of only a message", async () => {
      installFetchStub();
      const { file } = tinyFile(2);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        maxChunkRetries: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(403, '{"error":"forbidden"}');

      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ChunkUploadError);
      const typed = err as ChunkUploadError;
      expect(typed.kind).toBe("http");
      expect(typed.status).toBe(403);
      expect(typed.retryable).toBe(false);
      // The daemon's own message is preserved for diagnostics.
      expect(typed.detail).toContain("forbidden");
    });

    it("does NOT retry 507 — a full volume will not empty itself", async () => {
      installFetchStub();
      const { file } = tinyFile(3);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        maxChunkRetries: 5,
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(507);

      await expect(p).rejects.toThrow(/status 507/);
      await tick(20);
      expect(MockXHR.instances.length).toBe(1);
    });

    it("retries 429 (explicit backpressure)", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(4);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        maxChunkRetries: 3,
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);

      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(429);
      await MockXHR.waitForCount(2, 1000);
      MockXHR.last().finishOK(200);

      await expect(p).resolves.toBeTruthy();
      expect(MockXHR.instances.length).toBe(2);
    });

    it("does NOT retry 501", async () => {
      installFetchStub();
      const { file } = tinyFile(5);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        maxChunkRetries: 5,
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(501);

      await expect(p).rejects.toThrow(/status 501/);
      await tick(20);
      expect(MockXHR.instances.length).toBe(1);
    });
  });

  // ---------- Stall and response timeouts ----------

  describe("timeouts", () => {
    it("aborts and retries a chunk that stops moving", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(6);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        stallTimeoutMs: 30,
        chunkRetryDelayMs: 1,
        maxChunkRetries: 2,
      });
      const p = client.upload(file, -1);

      // Never emit progress: the stall watchdog is the only thing that can
      // end this attempt.
      await MockXHR.waitForCount(2, 2000);
      MockXHR.last().finishOK(200);

      await expect(p).resolves.toBeTruthy();
      expect(MockXHR.instances.length).toBe(2);
    });

    it("classifies a stall as a retryable timeout, not as an abort", async () => {
      installFetchStub();
      const { file } = tinyFile(7);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        stallTimeoutMs: 20,
        maxChunkRetries: 1,
      });
      const err = await client.upload(file, -1).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(ChunkUploadError);
      const typed = err as ChunkUploadError;
      expect(typed.kind).toBe("timeout");
      expect(typed.retryable).toBe(true);
      expect(typed.message).toMatch(/timed out \(stall\)/);
    });

    it("does NOT kill a slow-but-alive connection", async () => {
      const fetchStub = installFetchStub();
      // 20 bytes so progress has room to keep climbing.
      const { file, hash, size } = tinyFile(8, 20);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        // Well under the total transfer time below: the only reason this
        // survives is that every progress tick re-arms the budget.
        stallTimeoutMs: 40,
        maxChunkRetries: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);

      const xhr = MockXHR.last();
      for (let loaded = 1; loaded <= 10; loaded++) {
        await tick(15);
        xhr.emitProgress(loaded, size);
      }
      // 150ms elapsed against a 40ms stall budget, yet still alive.
      expect(MockXHR.instances.length).toBe(1);

      xhr.finishOK(200);
      await expect(p).resolves.toBeTruthy();
    });

    it("times out while waiting for the response after the body is sent", async () => {
      installFetchStub();
      const { file } = tinyFile(9);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        // Stall budget generous, response budget tight: isolates phase two.
        stallTimeoutMs: 5000,
        responseTimeoutMs: 25,
        maxChunkRetries: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);

      // Body handed to the transport; from here only the server can talk.
      MockXHR.last().finishUploadBody();

      await expect(p).rejects.toThrow(/timed out \(response\)/);
    });

    it("treats 0 as 'no timeout' for both budgets", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(10);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        stallTimeoutMs: 0,
        responseTimeoutMs: 0,
        maxChunkRetries: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishUploadBody();

      // Silence well past what any enabled budget would tolerate.
      await tick(80);
      expect(MockXHR.instances.length).toBe(1);

      MockXHR.last().finishOK(200);
      await expect(p).resolves.toBeTruthy();
    });

    it("keeps a caller-initiated abort permanent (not confused with a timeout)", async () => {
      installFetchStub();
      const { file } = tinyFile(11);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        stallTimeoutMs: 5000,
        maxChunkRetries: 5,
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      client.abort();

      const err = await p.then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ChunkUploadError);
      const typed = err as ChunkUploadError;
      expect(typed.kind).toBe("abort");
      expect(typed.retryable).toBe(false);

      // No retry was attempted despite a budget of 5.
      await tick(20);
      expect(MockXHR.instances.length).toBe(1);
    });
  });

  // ---------- finish retries ----------

  describe("finish retries", () => {
    /** Drive a single-chunk upload up to the point `finish` is called. */
    async function uploadUntilFinish(client: UploaderClient, file: File) {
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      return p;
    }

    it("retries a transient 5xx and succeeds", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(12);
      fetchStub.queue.push({ status: 503, body: {} });
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
      });

      await expect(uploadUntilFinish(client, file)).resolves.toBeTruthy();
      expect(fetchStub.calls.length).toBe(2);
    });

    it("does NOT retry 507 on finish", async () => {
      const fetchStub = installFetchStub();
      const { file } = tinyFile(13);
      fetchStub.queue.push({ status: 507, body: {} });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
      });

      await expect(uploadUntilFinish(client, file)).rejects.toThrow(
        /Failed to finish upload/,
      );
      expect(fetchStub.calls.length).toBe(1);
    });

    it("does NOT retry a checksum mismatch — it is a fact, not a hiccup", async () => {
      const fetchStub = installFetchStub();
      const { file, size } = tinyFile(14);
      fetchStub.queue.push({
        status: 200,
        body: { hash: "definitely-not-the-hash", length: size },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
      });

      await expect(uploadUntilFinish(client, file)).rejects.toThrow(
        /Checksum mismatch/,
      );
      expect(fetchStub.calls.length).toBe(1);
    });

    it("gives up after maxFinishRetries and propagates the last failure", async () => {
      const fetchStub = installFetchStub();
      const { file } = tinyFile(15);
      for (let i = 0; i < 3; i++) {
        fetchStub.queue.push({ status: 503, body: {} });
      }

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        maxFinishRetries: 3,
        chunkRetryDelayMs: 1,
      });

      await expect(uploadUntilFinish(client, file)).rejects.toThrow(
        /HTTP 503/,
      );
      expect(fetchStub.calls.length).toBe(3);
    });

    it("reports finish retries through onChunkRetry with phase 'finish'", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(16);
      fetchStub.queue.push({ status: 502, body: {} });
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const seen: ChunkRetryInfo[] = [];
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
        onChunkRetry: (info) => seen.push(info),
      });

      await expect(uploadUntilFinish(client, file)).resolves.toBeTruthy();
      expect(seen).toHaveLength(1);
      expect(seen[0].phase).toBe("finish");
      expect(seen[0].chunkIndex).toBe(-1);
      expect(seen[0].error.message).toMatch(/HTTP 502/);
    });
  });

  // ---------- create=1 wire contract ----------

  describe("create=1 query parameter", () => {
    /**
     * The README used to claim `create=1` goes out "on the first chunk";
     * the client actually stamps it onto the upload URL once, before the
     * chunk loop, so **every** chunk carries it. The daemon tolerates that
     * today, which is the only reason multi-chunk uploads work at all.
     *
     * This pins the real behaviour so the two cannot drift apart again. If
     * the daemon ever enforces create-if-absent semantics, this test is the
     * one that has to change — deliberately, not by accident.
     */
    it("is sent on EVERY chunk, not just the first", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(10).map((_, i) => i + 1);
      const file = makeFile(bytes);
      const hash = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push({ status: 200, body: { hash, length: bytes.length } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, 4); // 4 + 4 + 2 = 3 chunks

      for (let i = 1; i <= 3; i++) {
        await MockXHR.waitForCount(i);
        expect(MockXHR.last().url).toContain("create=1");
        MockXHR.last().finishOK(200);
      }

      await expect(p).resolves.toBeTruthy();
      expect(MockXHR.instances.length).toBe(3);
    });

    it("is omitted entirely when overwrite is true", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(18);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1, true);

      await MockXHR.waitForCount(1);
      expect(MockXHR.last().url).not.toContain("create=1");
      MockXHR.last().finishOK(200);

      await expect(p).resolves.toBeTruthy();
    });
  });

  // ---------- onFinalize ----------

  describe("onFinalize", () => {
    it("is NOT retried — the move it performs is not idempotent", async () => {
      const fetchStub = installFetchStub();
      const { file, hash, size } = tinyFile(17);
      fetchStub.queue.push({ status: 200, body: { hash, length: size } });

      const onFinalize = vi.fn(async () => {
        throw new Error("move exploded");
      });
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
        onFinalize,
      });

      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);

      await expect(p).rejects.toThrow(/move exploded/);
      expect(onFinalize).toHaveBeenCalledTimes(1);
    });
  });
});
