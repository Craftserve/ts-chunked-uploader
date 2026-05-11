import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UploaderClient } from "../UploaderClient";
import { ProgressState, UploadState } from "../types";
import {
  MockXHR,
  expectedHashForFile,
  installCryptoStub,
  installFetchStub,
  makeFile,
  tick,
  toBase64Url,
} from "./testUtils";

const UPLOAD_URL = "/api/uploads/{upload_id}/chunk";
const FINISH_URL = "/api/uploads/{upload_id}/finish";

function defaultFinishResponse(length: number, hash: string) {
  return { status: 200, body: { hash, length } };
}

describe("UploaderClient", () => {
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

  // ---------- Single-chunk upload (chunkSize = -1) ----------

  describe("single-chunk upload (size = -1)", () => {
    it("uploads, finalizes, and returns the base64url upload_id", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const file = makeFile(bytes);
      const expectedHash = expectedHashForFile(bytes.length, bytes[0]);
      const expectedUploadId = toBase64Url(expectedHash);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, expectedHash));

      const onFinalize = vi.fn(async () => {});
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        onFinalize,
      });

      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const promise = client.upload(file, -1);

      // Wait for the XHR to be created by the upload loop.
      await MockXHR.waitForCount(1);
      const xhr = MockXHR.last();
      expect(xhr.method).toBe("PUT");
      // upload_id is base64url(sha256) — URL-safe, no '+' / '/' / '=' to escape.
      // See "URL safety" tests below for the empty-file regression.
      expect(xhr.url).toContain(toBase64Url(expectedHash));
      // Single chunk should NOT have a Range header.
      expect(xhr.requestHeaders["Range"]).toBeUndefined();

      xhr.emitProgress(bytes.length);
      xhr.finishOK(200);

      const result = await promise;
      expect(result).toBe(expectedUploadId);

      // finish was called, onFinalize was awaited.
      expect(fetchStub.calls.length).toBe(1);
      expect(fetchStub.calls[0].url).toContain(toBase64Url(expectedHash));
      // onFinalize gets the std-base64 hash (not the base64url path id).
      expect(onFinalize).toHaveBeenCalledWith(expectedHash);

      // Terminal state == Done; Initializing and Finishing also seen.
      const seenStates = states.map((s) => s.state);
      expect(seenStates).toContain(UploadState.Initializing);
      expect(seenStates).toContain(UploadState.Uploading);
      expect(seenStates).toContain(UploadState.Finishing);
      expect(states[states.length - 1].state).toBe(UploadState.Done);
      expect(states[states.length - 1].uploaded).toBe(bytes.length);
      expect(states[states.length - 1].total).toBe(bytes.length);
    });

    it("appends ?create=1 when overwrite is false (default)", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array([9]);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      expect(MockXHR.last().url).toMatch(/[?&]create=1\b/);
      MockXHR.last().finishOK(200);
      await p;
    });

    it("does NOT append create=1 when overwrite is true", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array([9]);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1, true);
      await MockXHR.waitForCount(1);
      expect(MockXHR.last().url).not.toMatch(/create=1/);
      MockXHR.last().finishOK(200);
      await p;
    });

    it("does NOT set a Range header for a single chunk", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array([5, 5, 5, 5]);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      expect(MockXHR.last().requestHeaders["Range"]).toBeUndefined();
      MockXHR.last().finishOK(200);
      await p;
    });
  });

  // ---------- Multi-chunk upload ----------

  describe("multi-chunk upload", () => {
    it("splits into N chunks with inclusive Range: bytes=start-(end-1)", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(10).map((_, i) => i + 1);
      const file = makeFile(bytes); // size = 10
      const chunkSize = 4; // 4 + 4 + 2 = 3 chunks
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const p = client.upload(file, chunkSize);

      // chunk 0: 0-3
      await MockXHR.waitForCount(1);
      let xhr = MockXHR.last();
      expect(xhr.requestHeaders["Range"]).toBe("bytes=0-3");
      xhr.emitProgress(4);
      xhr.finishOK(200);

      // chunk 1: 4-7
      await MockXHR.waitForCount(2);
      xhr = MockXHR.last();
      expect(xhr.requestHeaders["Range"]).toBe("bytes=4-7");
      xhr.emitProgress(4);
      xhr.finishOK(200);

      // chunk 2: 8-9
      await MockXHR.waitForCount(3);
      xhr = MockXHR.last();
      expect(xhr.requestHeaders["Range"]).toBe("bytes=8-9");
      xhr.emitProgress(2);
      xhr.finishOK(200);

      await p;

      // total uploaded must equal file size at end (Done).
      const done = states[states.length - 1];
      expect(done.state).toBe(UploadState.Done);
      expect(done.uploaded).toBe(bytes.length);
    });

    it("aggregates per-chunk progress monotonically", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(20).map((_, i) => i);
      const file = makeFile(bytes); // 20 bytes
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        // Disable bytes/time throttling for a deterministic trace.
        progressReportIntervalMs: 0,
        progressReportBytes: 1,
      } as any);

      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));
      const p = client.upload(file, 10); // 2 chunks

      await MockXHR.waitForCount(1);
      MockXHR.last().emitProgress(5);
      MockXHR.last().emitProgress(10);
      MockXHR.last().finishOK(200);

      await MockXHR.waitForCount(2);
      MockXHR.last().emitProgress(5);
      MockXHR.last().emitProgress(10);
      MockXHR.last().finishOK(200);

      await p;

      // uploaded must be non-decreasing across the entire reported trace.
      let prev = -1;
      for (const s of states) {
        expect(s.uploaded).toBeGreaterThanOrEqual(prev);
        prev = s.uploaded;
      }
      // Last reported uploaded must equal total.
      expect(states[states.length - 1].uploaded).toBe(bytes.length);
    });
  });

  // ---------- Empty file ----------

  describe("empty file", () => {
    it("does not throw RangeError and completes successfully", async () => {
      const fetchStub = installFetchStub();
      const file = makeFile(new Uint8Array(0));
      const h = expectedHashForFile(0);
      fetchStub.queue.push(defaultFinishResponse(0, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const p = client.upload(file, 5);

      // With size === 0, code forces chunks=1. So one XHR is created with an empty chunk.
      await MockXHR.waitForCount(1);
      const xhr = MockXHR.last();
      // For chunks=1 there should be no Range header.
      expect(xhr.requestHeaders["Range"]).toBeUndefined();
      xhr.finishOK(200);

      const result = await p;
      expect(result).toBe(toBase64Url(h));
      expect(states[states.length - 1].state).toBe(UploadState.Done);
      expect(states[states.length - 1].uploaded).toBe(0);
      expect(states[states.length - 1].total).toBe(0);
    });

    it("treats length=0 from the finish endpoint as a valid response (not 'No hash returned')", async () => {
      const fetchStub = installFetchStub();
      const file = makeFile(new Uint8Array(0));
      const h = expectedHashForFile(0);
      // Explicit length: 0 — must NOT be confused with a missing field.
      fetchStub.queue.push({ status: 200, body: { hash: h, length: 0 } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).resolves.toBe(toBase64Url(h));
    });

    it("still rejects when the finish endpoint omits the length field", async () => {
      const fetchStub = installFetchStub();
      const file = makeFile(new Uint8Array(0));
      const h = expectedHashForFile(0);
      // length missing entirely — should still be treated as an error.
      fetchStub.queue.push({ status: 200, body: { hash: h } });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/No hash returned from server/);
    });

    it("rejects when hash is present but not a string", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(1);
      const file = makeFile(bytes);
      // hash sent as number — must not be accepted (FinishResponse.hash: string).
      fetchStub.queue.push({
        status: 200,
        body: { hash: 12345, length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/No hash returned from server/);
    });
  });

  // ---------- Abort ----------

  describe("abort", () => {
    it("aborts an in-flight chunk and rejects with 'Upload aborted'", async () => {
      installFetchStub();
      const bytes = new Uint8Array(8).fill(7);
      const file = makeFile(bytes);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      client.abort();

      await expect(p).rejects.toThrow(/abort/i);
      expect(states[states.length - 1].state).toBe(UploadState.Error);
    });
  });

  // ---------- Retry behavior ----------

  describe("chunk retries", () => {
    it("retries on network error and succeeds on the next attempt", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(3);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const onChunkRetry = vi.fn();
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 5,
        onChunkRetry,
      });

      const p = client.upload(file, -1);

      // First attempt → network error.
      await MockXHR.waitForCount(1);
      MockXHR.last().networkError();

      // Second attempt should follow after the (short) backoff.
      await MockXHR.waitForCount(2, 1000);
      expect(onChunkRetry).toHaveBeenCalledTimes(1);
      const info = onChunkRetry.mock.calls[0][0];
      expect(info.attempt).toBe(1);
      expect(info.chunkIndex).toBe(0);
      expect(info.error).toBeInstanceOf(Error);

      MockXHR.last().finishOK(200);
      await expect(p).resolves.toBe(toBase64Url(h));
    });

    it("retries on 5xx", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(2);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);

      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(502);
      await MockXHR.waitForCount(2, 1000);
      MockXHR.last().finishOK(200);
      await expect(p).resolves.toBe(toBase64Url(h));
    });

    it("does NOT retry on 4xx (non-retryable)", async () => {
      installFetchStub();
      const bytes = new Uint8Array(4).fill(1);
      const file = makeFile(bytes);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
      });
      const p = client.upload(file, -1);

      await MockXHR.waitForCount(1);
      MockXHR.last().finishError(400);
      await expect(p).rejects.toThrow(/Chunk upload failed with status 400/);
      // Should not have created a second XHR.
      expect(MockXHR.instances.length).toBe(1);
    });

    it("gives up after maxChunkRetries and propagates the last error", async () => {
      installFetchStub();
      const bytes = new Uint8Array(2).fill(0);
      const file = makeFile(bytes);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
        maxChunkRetries: 3,
      });
      const p = client.upload(file, -1);

      // Fail all 3 attempts with a 5xx.
      for (let i = 0; i < 3; i++) {
        await MockXHR.waitForCount(i + 1, 1000);
        MockXHR.last().finishError(503);
      }
      await expect(p).rejects.toThrow(/status 503/);
      // Make sure it stopped at exactly 3 attempts.
      await tick(20);
      expect(MockXHR.instances.length).toBe(3);
    });

    it("abort during retry backoff stops further attempts immediately", async () => {
      installFetchStub();
      const bytes = new Uint8Array(2).fill(0);
      const file = makeFile(bytes);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 5_000, // long backoff that we will short-circuit
      });
      const p = client.upload(file, -1);

      await MockXHR.waitForCount(1);
      MockXHR.last().networkError();

      // Give the retry loop a moment to enter delayWithAbort().
      await tick(20);
      const t0 = Date.now();
      client.abort();
      await expect(p).rejects.toThrow(/abort/i);
      expect(Date.now() - t0).toBeLessThan(500);
    });

    it("maxChunkRetries=1 disables retries", async () => {
      installFetchStub();
      const bytes = new Uint8Array(2).fill(0);
      const file = makeFile(bytes);

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        chunkRetryDelayMs: 1,
        maxChunkRetries: 1,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().networkError();
      await expect(p).rejects.toThrow(/Network error during upload/);
      await tick(10);
      expect(MockXHR.instances.length).toBe(1);
    });
  });

  // ---------- Progress throttling ----------

  describe("progress throttling", () => {
    it("throttles intermediate progress updates by byte threshold", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(50).fill(1);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        // Only report after 1000 bytes — small intermediate progress should be suppressed.
        progressReportBytes: 1000,
        progressReportIntervalMs: 60_000,
      } as any);

      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);

      // Emit many small progress events.
      for (let i = 1; i <= 9; i++) {
        MockXHR.last().emitProgress(i);
      }
      MockXHR.last().finishOK(200);
      await p;

      // Only the important states (Initializing/Uploading-start/Finishing/Done)
      // and possibly the final chunk-complete onload should have been reported —
      // none of the small intermediate steps.
      const uploadingStates = states.filter(
        (s) => s.state === UploadState.Uploading,
      );
      // Allow the "Uploading" kickoff (uploaded=0) and a final chunk-completion update.
      // We're checking that we did NOT get one notification per emitProgress call.
      expect(uploadingStates.length).toBeLessThan(5);
    });

    it("ensures the initial onprogress() call fires synchronously with lastProgress", () => {
      installFetchStub();
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const cb = vi.fn();
      client.onprogress(cb);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0][0].state).toBe(UploadState.Initializing);
    });

    it("unsubscribes via the returned function", async () => {
      installFetchStub();
      const bytes = new Uint8Array(4).fill(1);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      const fs = installFetchStub();
      fs.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const cb = vi.fn();
      const unsubscribe = client.onprogress(cb);
      unsubscribe();
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await p;
      // Only the synchronous initial call before unsubscribe should have happened.
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  // ---------- Finish/verify ----------

  describe("finish verification", () => {
    it("throws on checksum mismatch", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(2);
      const file = makeFile(bytes);
      // Return WRONG hash.
      fetchStub.queue.push({
        status: 200,
        body: { hash: "wrong-hash", length: bytes.length },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/Checksum mismatch/);
    });

    it("throws on length mismatch", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(2);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push({
        status: 200,
        body: { hash: h, length: bytes.length + 1 },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/length mismatch/);
    });

    it("strips the alg prefix from server hash before comparing", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(3);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push({
        status: 200,
        body: { hash: "sha-256=" + h, length: bytes.length },
      });
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).resolves.toBe(toBase64Url(h));
    });

    it("throws when the finish endpoint returns non-200", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(4);
      const file = makeFile(bytes);
      fetchStub.queue.push({ status: 500, body: {} });
      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/Failed to finish upload/);
    });
  });

  // ---------- onFinalize ----------

  describe("onFinalize", () => {
    it("is awaited before resolving and receives the std-base64 hash", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(7);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      let finalizeStarted = false;
      let finalizeResolve!: () => void;
      const finalizePromise = new Promise<void>((r) => (finalizeResolve = r));
      const onFinalize = vi.fn(async (id: string) => {
        finalizeStarted = true;
        expect(id).toBe(h);
        await finalizePromise;
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        onFinalize,
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);

      // Give time for finish + onFinalize() to be called.
      await tick(20);
      expect(finalizeStarted).toBe(true);
      // Resolve onFinalize and ensure upload() resolves only after.
      let uploadResolved = false;
      p.then(() => (uploadResolved = true));
      await tick(10);
      expect(uploadResolved).toBe(false);
      finalizeResolve();
      await p;
    });

    it("propagates onFinalize errors as a wrapped upload failure", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(8);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        onFinalize: async () => {
          throw new Error("finalize boom");
        },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().finishOK(200);
      await expect(p).rejects.toThrow(/finalize boom/);
    });
  });

  // ---------- size > 0 single-chunk shortcut ----------

  it("treats size >= file.size as a single-chunk upload (no Range header)", async () => {
    const fetchStub = installFetchStub();
    const bytes = new Uint8Array(4).fill(9);
    const file = makeFile(bytes);
    const h = expectedHashForFile(bytes.length, bytes[0]);
    fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

    const client = new UploaderClient({
      endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
    });
    const p = client.upload(file, 100); // chunkSize > file.size
    await MockXHR.waitForCount(1);
    expect(MockXHR.last().requestHeaders["Range"]).toBeUndefined();
    MockXHR.last().finishOK(200);
    await p;
  });

  // ---------- URL safety ----------

  describe("URL safety", () => {
    it("uses base64url upload_id in the URL (no '+' / '/' / '=' in path)", async () => {
      const fetchStub = installFetchStub();
      const bytes = new Uint8Array(4).fill(1);
      const file = makeFile(bytes);
      const h = expectedHashForFile(bytes.length, bytes[0]);
      fetchStub.queue.push(defaultFinishResponse(bytes.length, h));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);
      const url = MockXHR.last().url;
      // Base64url form appears in the URL.
      expect(url).toContain(toBase64Url(h));
      // The path segment that holds upload_id must contain none of '+' / '/' / '=' /
      // their percent-encoded forms.
      const pathSegment = new URL(url).pathname;
      expect(pathSegment).not.toMatch(/[+=]|%2B|%2F|%3D/i);
      MockXHR.last().finishOK(200);
      await p;
    });

    // WEB-1549 regression: uploading an empty file yields
    //   std-base64(SHA-256("")) = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="
    // which contains a literal '/' that would split the path. base64url turns
    // that into "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU" — single segment.
    it("uses base64url for the empty-file SHA-256 upload_id (WEB-1549)", async () => {
      const fetchStub = installFetchStub();
      const file = makeFile(new Uint8Array(0));

      // Force the digest stub to return the canonical SHA-256("") bytes.
      const emptyHashBytes = new Uint8Array([
        0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8,
        0x99, 0x6f, 0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c,
        0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55,
      ]);
      const stdBase64 = "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
      const base64url = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU";
      (globalThis as any).crypto.subtle.digest = async () =>
        emptyHashBytes.buffer.slice(0);

      // Daemon returns std-base64 in `hash` field — we keep that compare value.
      fetchStub.queue.push({
        status: 200,
        body: { hash: stdBase64, length: 0 },
      });

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
      });
      const p = client.upload(file, -1);
      await MockXHR.waitForCount(1);

      const xhrUrl = MockXHR.last().url;
      // URL contains the base64url form; raw std-base64 absent (no '+/=').
      expect(xhrUrl).toContain(base64url);
      expect(xhrUrl).not.toContain(stdBase64);
      // Triple-check the path segment is clean.
      expect(new URL(xhrUrl).pathname).not.toMatch(/[+=]|%2B|%2F|%3D/i);

      MockXHR.last().finishOK(200);
      // upload() resolves to the base64url upload_id.
      await expect(p).resolves.toBe(base64url);

      // Same guarantee on the finish endpoint URL.
      const finishUrl = fetchStub.calls[0].url;
      expect(finishUrl).toContain(base64url);
      expect(finishUrl).not.toContain(stdBase64);
    });
  });

  // ---------- Successive uploads on same instance ----------

  describe("successive uploads on the same client", () => {
    // The Initializing state on each upload() call is a forced-report state,
    // which resets `lastReportedUploaded` to 0 — so the throttling state
    // does NOT leak between consecutive uploads in practice. This test
    // pins that observed behavior.
    it("reports intermediate Uploading progress on a 2nd, smaller upload", async () => {
      const fetchStub = installFetchStub();

      // First upload: 50 bytes.
      const big = new Uint8Array(50).fill(7);
      const file1 = makeFile(big, "big.bin");
      const h1 = expectedHashForFile(big.length, big[0]);
      fetchStub.queue.push(defaultFinishResponse(big.length, h1));

      const client = new UploaderClient({
        endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
        progressReportBytes: 5,
        progressReportIntervalMs: 0,
      } as any);

      // Drain the first upload.
      const p1 = client.upload(file1, -1);
      await MockXHR.waitForCount(1);
      MockXHR.last().emitProgress(50);
      MockXHR.last().finishOK(200);
      await p1;

      // Second upload: 10 bytes (smaller than first).
      const small = new Uint8Array(10).fill(3);
      const file2 = makeFile(small, "small.bin");
      const h2 = expectedHashForFile(small.length, small[0]);
      fetchStub.queue.push(defaultFinishResponse(small.length, h2));

      const states: ProgressState[] = [];
      client.onprogress((s) => states.push({ ...s }));

      const p2 = client.upload(file2, -1);
      await MockXHR.waitForCount(2);

      // Emit intermediate progress for the second upload.
      for (let i = 1; i <= 9; i++) {
        MockXHR.last().emitProgress(i);
      }
      MockXHR.last().finishOK(200);
      await p2;

      // We expect at least one intermediate Uploading update where
      // uploaded > 0 AND uploaded < total. With the bug, no such report
      // exists because the throttle still thinks 50 bytes were reported.
      const intermediate = states.filter(
        (s) =>
          s.state === UploadState.Uploading &&
          s.uploaded > 0 &&
          s.uploaded < small.length,
      );
      expect(intermediate.length).toBeGreaterThan(0);
    });
  });

  // ---------- Hash computation errors ----------

  it("rejects when crypto.subtle.digest throws", async () => {
    installFetchStub();
    const bytes = new Uint8Array(4).fill(1);
    const file = makeFile(bytes);
    // Override crypto stub to throw.
    (globalThis as any).crypto.subtle.digest = async () => {
      throw new Error("crypto broken");
    };
    const client = new UploaderClient({
      endpoints: { upload: UPLOAD_URL, finish: FINISH_URL },
    });
    await expect(client.upload(file, -1)).rejects.toThrow(
      /Failed to calculate checksum/,
    );
  });
});
