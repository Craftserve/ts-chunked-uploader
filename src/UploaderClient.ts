import {
  ChunkUploadError,
  isRetryableError,
  isRetryableStatus,
  truncateDetail,
} from "./errors";
import { toBase64Url } from "./helpers/base64url";
import { formatHashFromApi } from "./helpers/formatHash";
import { Sha256 } from "./helpers/sha256";
import {
  ChunkedUploaderClientProps,
  ChunkRetryInfo,
  FinishResponse,
  ProgressState,
  RetryPhase,
  UploadState,
} from "./types";

const DEFAULT_HASH_ALG = "sha-256";
const DEFAULT_MAX_CHUNK_RETRIES = 10;
const DEFAULT_CHUNK_RETRY_DELAY_MS = 10_000;

/**
 * `finish` is a cheap, idempotent GET — worth retrying, but not with the
 * chunk budget. Re-sending 25 MiB deserves ten attempts; re-asking the
 * daemon for a hash does not.
 */
const DEFAULT_MAX_FINISH_RETRIES = 3;

/**
 * No bytes moved for this long → the connection is presumed dead.
 * Re-armed on every progress tick, so it is independent of bandwidth.
 */
const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/**
 * Budget for the server's answer once the body has been handed over.
 * Deliberately generous — see `responseTimeoutMs` in `types.ts`.
 */
const DEFAULT_RESPONSE_TIMEOUT_MS = 300_000;

/** `ChunkRetryInfo.chunkIndex` for retries that are not about a chunk. */
const NOT_A_CHUNK = -1;

/**
 * Above this size the checksum is computed incrementally instead of by
 * loading the whole file. Chosen so ordinary uploads keep the faster
 * BoringSSL path while anything big enough to threaten the renderer's
 * memory does not allocate a buffer its own size.
 */
const DEFAULT_HASH_STREAMING_THRESHOLD_BYTES = 64 * 1024 * 1024;

/** How much of the file is resident at once while hashing incrementally. */
const DEFAULT_HASH_SLICE_BYTES = 8 * 1024 * 1024;

/** Raw digest bytes to the std-base64 the daemon compares against. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Bind an outer abort signal and a timeout onto one controller.
 *
 * `AbortSignal.any` would do this in one line but is too new to rely on
 * here (and is missing from parts of the test environment), so the linkage
 * is done by hand. `timedOut` lets the caller tell "the deadline passed"
 * apart from "the caller cancelled" — they map to opposite retry verdicts.
 */
function linkAbortWithTimeout(
  source: AbortSignal | undefined,
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onSourceAbort = () => controller.abort();

  if (source) {
    if (source.aborted) {
      controller.abort();
    } else {
      source.addEventListener("abort", onSourceAbort, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (source) {
        try {
          source.removeEventListener("abort", onSourceAbort);
        } catch {
          /* listener already gone */
        }
      }
    },
  };
}

/**
 * Read a response body as text without ever throwing.
 *
 * Used only to enrich an error with the daemon's own message. Response-like
 * stubs in tests may not implement `text()`, and a body that fails to read
 * must never replace the real failure with a secondary one.
 */
async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    if (typeof response.text !== "function") return undefined;
    return await response.text();
  } catch {
    return undefined;
  }
}

export class UploaderClient {
  private config: ChunkedUploaderClientProps;
  private abortController?: AbortController;
  private aborted = false;
  private progressCallback?: (s: ProgressState) => void;

  private lastProgress: ProgressState = {
    uploaded: 0,
    total: 0,
    state: UploadState.Initializing,
  };

  // ---- progress throttling ----
  private lastProgressReportTime: number = 0;
  private lastReportedUploaded: number = 0;
  private progressIntervalMs: number;
  private progressBytesThreshold: number;

  // ---- retry config ----
  private maxChunkRetries: number;
  private maxFinishRetries: number;
  private chunkRetryDelayMs: number;

  // ---- timeout config ----
  private stallTimeoutMs: number;
  private responseTimeoutMs: number;

  // ---- hashing config ----
  private hashStreamingThresholdBytes: number;
  private hashSliceBytes: number;

  constructor(config: ChunkedUploaderClientProps) {
    this.config = config;

    this.progressIntervalMs = config.progressReportIntervalMs ?? 1000;
    this.progressBytesThreshold = config.progressReportBytes ?? 1_000_000;

    this.maxChunkRetries = Math.max(
      1,
      config.maxChunkRetries ?? DEFAULT_MAX_CHUNK_RETRIES,
    );
    this.maxFinishRetries = Math.max(
      1,
      config.maxFinishRetries ?? DEFAULT_MAX_FINISH_RETRIES,
    );
    this.chunkRetryDelayMs =
      config.chunkRetryDelayMs ?? DEFAULT_CHUNK_RETRY_DELAY_MS;

    this.stallTimeoutMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.responseTimeoutMs =
      config.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;

    this.hashStreamingThresholdBytes =
      config.hashStreamingThresholdBytes ??
      DEFAULT_HASH_STREAMING_THRESHOLD_BYTES;
    // A zero or negative slice would loop forever; clamp to the default.
    this.hashSliceBytes =
      config.hashSliceBytes && config.hashSliceBytes > 0
        ? config.hashSliceBytes
        : DEFAULT_HASH_SLICE_BYTES;
  }

  /**
   * Sleep for `ms` milliseconds. Resolves when the timer fires; rejects with
   * a non-retryable abort error if the abort signal fires first, so a
   * user-initiated cancel does not have to wait out the remaining backoff.
   */
  private delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(
          new ChunkUploadError("Upload aborted", {
            kind: "abort",
            retryable: false,
          }),
        );
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(
          new ChunkUploadError("Upload aborted", {
            kind: "abort",
            retryable: false,
          }),
        );
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  onprogress(cb: (state: ProgressState) => void): () => void {
    this.progressCallback = cb;

    // keep previous behaviour: immediately call with lastProgress
    try {
      cb(this.lastProgress);
    } catch (e) {
      console.error("progress callback error:", e);
    }

    return () => {
      if (this.progressCallback === cb) {
        this.progressCallback = undefined;
      }
    };
  }

  /**
   * Reports progress but throttles frequent updates.
   * force = true -> always call callback (used for important states/errors).
   */
  private reportProgress(state: ProgressState, force = false) {
    // Always keep the lastProgress up to date (even if we don't notify callback every time).
    this.lastProgress = state;

    // If no callback - nothing to throttle
    if (!this.progressCallback) return;

    const now = Date.now();

    // Always report immediately for terminal/important states
    const importantStates = new Set<UploadState>([
      UploadState.Initializing,
      UploadState.Finishing,
      UploadState.Done,
      UploadState.Error,
    ]);

    const uploaded = state.uploaded ?? this.lastProgress.uploaded ?? 0;

    const timeSinceLast = now - this.lastProgressReportTime;
    const bytesSinceLast = Math.max(0, uploaded - this.lastReportedUploaded);

    const shouldReport =
      force ||
      importantStates.has(state.state) ||
      timeSinceLast >= this.progressIntervalMs ||
      bytesSinceLast >= this.progressBytesThreshold;

    if (!shouldReport) return;

    try {
      this.progressCallback(state);
      this.lastProgressReportTime = now;
      this.lastReportedUploaded = uploaded;
    } catch (e) {
      console.error("progress callback error:", e);
    }
  }

  abort() {
    this.aborted = true;
    if (this.abortController) {
      this.abortController.abort();
    }

    // force immediate error report
    this.reportProgress(
      {
        uploaded: this.lastProgress.uploaded,
        total: this.lastProgress.total,
        state: UploadState.Error,
      },
      true,
    );
  }

  private notifyRetry(info: {
    chunkIndex: number;
    phase: RetryPhase;
    attempt: number;
    maxAttempts: number;
    error: unknown;
  }) {
    if (!this.config.onChunkRetry) return;

    const payload: ChunkRetryInfo = {
      chunkIndex: info.chunkIndex,
      phase: info.phase,
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      error:
        info.error instanceof Error
          ? info.error
          : new Error(String(info.error)),
      willRetryInMs: this.chunkRetryDelayMs,
    };

    try {
      this.config.onChunkRetry(payload);
    } catch (cbErr) {
      console.error("onChunkRetry callback error:", cbErr);
    }
  }

  /**
   * Run `attempt` until it succeeds, the error is judged permanent, the
   * budget runs out, or the upload is aborted.
   *
   * Shared by the chunk loop and the `finish` call so both obey the same
   * abort semantics. Retryability comes off the typed error — never off the
   * message text.
   */
  private async runWithRetries<T>(
    attempt: (attemptNumber: number) => Promise<T>,
    opts: {
      signal: AbortSignal;
      maxAttempts: number;
      chunkIndex: number;
      phase: RetryPhase;
    },
  ): Promise<T> {
    const { signal, maxAttempts, chunkIndex, phase } = opts;
    let lastError: unknown = null;

    for (let n = 1; n <= maxAttempts; n++) {
      if (this.aborted || signal.aborted) {
        throw new ChunkUploadError("Upload aborted", {
          kind: "abort",
          retryable: false,
        });
      }

      try {
        return await attempt(n);
      } catch (err) {
        lastError = err;

        // Stop immediately on abort or non-retryable errors.
        if (this.aborted || signal.aborted || !isRetryableError(err)) break;

        // Out of attempts → give up and propagate the last failure.
        if (n >= maxAttempts) break;

        this.notifyRetry({
          chunkIndex,
          phase,
          attempt: n,
          maxAttempts,
          error: err,
        });

        // Wait the configured backoff before the next attempt. If abort
        // fires during the wait, propagate that abort instead of the
        // underlying failure.
        try {
          await this.delayWithAbort(this.chunkRetryDelayMs, signal);
        } catch (abortErr) {
          lastError = abortErr;
          break;
        }
      }
    }

    // `maxAttempts` is clamped to >= 1 in the constructor, so the loop
    // always ran at least once and `lastError` is set. The fallback exists
    // so a future caller passing 0 gets a real error rather than `throw null`.
    throw (
      lastError ??
      new ChunkUploadError("Upload failed with no attempts made", {
        kind: "unknown",
        retryable: false,
      })
    );
  }

  /**
   * Compute the file checksum (base64 of the raw digest bytes).
   *
   * Two paths, one result:
   *
   *  - **Whole-file** through `crypto.subtle.digest`, for anything at or
   *    below `hashStreamingThresholdBytes`. It is backed by BoringSSL and
   *    faster than any JS implementation, so it stays the default.
   *  - **Streaming** through the incremental hasher above that threshold.
   *    `file.arrayBuffer()` on a multi-gigabyte upload allocates a buffer
   *    the size of the file — a renderer OOM on exactly the files users
   *    least want to lose, and it would multiply once several uploads run
   *    concurrently. Streaming keeps a single slice resident.
   *
   * `sha256.test.ts` pins the incremental hasher against WebCrypto over
   * random inputs and every padding boundary, so which path runs cannot
   * change the digest.
   */
  private async computeHash(
    file: File,
    alg: string,
    signal?: AbortSignal,
  ): Promise<string> {
    // Normalize algorithm for Web Crypto (e.g. 'sha-256' -> 'SHA-256').
    // Web Crypto expects identifiers like "SHA-256".
    const cryptoAlg = alg.toUpperCase();

    try {
      // The incremental hasher only implements SHA-256, so anything else
      // takes the whole-file path regardless of size.
      const canStream =
        cryptoAlg === "SHA-256" &&
        this.hashStreamingThresholdBytes > 0 &&
        file.size > this.hashStreamingThresholdBytes;

      if (!canStream) {
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest(cryptoAlg, buffer);
        return bytesToBase64(new Uint8Array(digest));
      }

      const hasher = new Sha256();
      for (let offset = 0; offset < file.size; offset += this.hashSliceBytes) {
        // Hashing several GB takes real time. Without this an abort could
        // not land until the whole file had been read.
        if (this.aborted || signal?.aborted) {
          throw new ChunkUploadError("Upload aborted", {
            kind: "abort",
            retryable: false,
          });
        }

        const end = Math.min(offset + this.hashSliceBytes, file.size);
        const slice = await file.slice(offset, end).arrayBuffer();
        hasher.update(new Uint8Array(slice));
      }

      return bytesToBase64(hasher.digest());
    } catch (err) {
      if (err instanceof ChunkUploadError) throw err;
      throw new ChunkUploadError("Failed to calculate checksum: " + err, {
        kind: "unknown",
        retryable: false,
        cause: err,
      });
    }
  }

  /**
   * Upload a single chunk using XHR to preserve upload progress events.
   *
   * Two independent watchdogs guard the request, because XHR on its own
   * will wait forever on a half-open connection:
   *
   *  - **stall** — armed before `send()` and re-armed whenever more bytes
   *    go out. It fires only when *nothing* moves, so a slow-but-alive
   *    link keeps resetting it and is never killed.
   *  - **response** — armed once the body has been handed to the transport
   *    (`upload.loadend`). From there we are waiting on the server, and no
   *    further progress events are coming to prove liveness.
   *
   * A watchdog abort is reported as a retryable `timeout`, which is what
   * separates it from a caller-initiated `abort` (permanent).
   */
  private uploadChunk(
    uploadUrl: string,
    chunk: Blob,
    headers: Record<string, string>,
    i: number,
    chunkLength: number,
    progressPerChunk: number[],
    total: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      let settled = false;
      let listenerAdded = false;
      let timedOutPhase: "stall" | "response" | null = null;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let lastLoaded = 0;

      const uploadedSoFar = () =>
        Math.min(
          total,
          progressPerChunk.reduce((a, b) => a + b, 0),
        );

      const clearWatchdog = () => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };

      const armWatchdog = (ms: number, phase: "stall" | "response") => {
        clearWatchdog();
        if (!ms || ms <= 0) return;
        watchdog = setTimeout(() => {
          watchdog = null;
          timedOutPhase = phase;
          try {
            xhr.abort();
          } catch {
            // `onabort` may not fire if the request already finished;
            // settle explicitly so the promise can never dangle.
            fail(
              new ChunkUploadError(`Chunk upload timed out (${phase})`, {
                kind: "timeout",
                retryable: true,
              }),
            );
          }
        }, ms);
      };

      const onAbortSignal = () => {
        try {
          xhr.abort();
        } catch {
          console.error("Failed to abort xhr");
        }
      };

      const cleanup = () => {
        clearWatchdog();
        if (signal && listenerAdded) {
          try {
            signal.removeEventListener("abort", onAbortSignal);
          } catch {
            /* listener already gone */
          }
        }
      };

      const fail = (err: ChunkUploadError) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        reject(err);
      };

      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      if (signal) {
        signal.addEventListener("abort", onAbortSignal, { once: true });
        listenerAdded = true;
      }

      xhr.open("PUT", uploadUrl, true);

      // credentials handling - preserve previous behaviour
      const maybeCredentials = (
        this.config.headers as Record<string, string> | undefined
      )?.credentials;
      if (maybeCredentials && maybeCredentials === "include") {
        xhr.withCredentials = true;
      }

      for (const [k, v] of Object.entries(headers)) {
        if (!v) continue;
        const lower = k.toLowerCase();
        if (lower === "content-type" || lower === "credentials") continue;
        try {
          xhr.setRequestHeader(k, v);
        } catch {
          /* header rejected by the agent — not worth failing the upload */
        }
      }

      xhr.upload.onprogress = (ev) => {
        // ev.loaded should be present; clamp to chunkLength.
        const reportedLoaded = typeof ev.loaded === "number" ? ev.loaded : 0;
        const loaded = Math.min(chunkLength, reportedLoaded);

        // Only *forward* movement counts as liveness. A repeat event at the
        // same offset must not keep a dead connection alive.
        if (loaded > lastLoaded) {
          lastLoaded = loaded;
          armWatchdog(this.stallTimeoutMs, "stall");
        }

        // Do not decrease previously recorded progress for this chunk (prevents regressions / double-counting issues)
        progressPerChunk[i] = Math.max(progressPerChunk[i] || 0, loaded);

        this.reportProgress({
          uploaded: uploadedSoFar(),
          total,
          state: UploadState.Uploading,
          currentChunkSize: chunkLength,
        });
      };

      // Body fully handed to the transport: no more progress events are
      // coming, so switch from the stall budget to the response budget.
      xhr.upload.onloadend = () => {
        if (settled) return;
        armWatchdog(this.responseTimeoutMs, "response");
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          // ensure chunk considered fully uploaded
          progressPerChunk[i] = chunkLength;

          this.reportProgress({
            uploaded: uploadedSoFar(),
            total,
            state: UploadState.Uploading,
            currentChunkSize: chunkLength,
          });

          succeed();
          return;
        }

        const detail = truncateDetail(xhr.responseText);
        fail(
          new ChunkUploadError(
            `Chunk upload failed with status ${xhr.status}` +
              (detail ? `: ${detail}` : ""),
            {
              kind: "http",
              status: xhr.status,
              retryable: isRetryableStatus(xhr.status),
              detail,
            },
          ),
        );
      };

      xhr.onerror = () => {
        fail(
          new ChunkUploadError("Network error during upload", {
            kind: "network",
            retryable: true,
          }),
        );
      };

      xhr.onabort = () => {
        if (timedOutPhase) {
          fail(
            new ChunkUploadError(
              `Chunk upload timed out (${timedOutPhase})`,
              { kind: "timeout", retryable: true },
            ),
          );
          return;
        }
        fail(
          new ChunkUploadError("Upload aborted", {
            kind: "abort",
            retryable: false,
          }),
        );
      };

      try {
        xhr.setRequestHeader(
          "Content-type",
          // keep previous behaviour (fallback to octet-stream)
          (this.config.headers as Record<string, string> | undefined)?.[
            "Content-type"
          ] ||
            (chunk instanceof File
              ? chunk.type || "application/octet-stream"
              : "application/octet-stream") ||
            (this.config.headers as Record<string, string> | undefined)?.[
              "content-type"
            ] ||
            (chunk instanceof Blob && chunk.type) ||
            "application/octet-stream",
        );
      } catch {
        /* agent refused the header — the daemon defaults to octet-stream */
      }

      try {
        // Arm the stall budget before handing the body over, so a request
        // that never starts moving is caught too.
        armWatchdog(this.stallTimeoutMs, "stall");
        xhr.send(chunk);
      } catch (err) {
        fail(
          new ChunkUploadError(
            `Failed to send chunk: ${err instanceof Error ? err.message : String(err)}`,
            { kind: "unknown", retryable: true, cause: err },
          ),
        );
      }
    });
  }

  /**
   * Finish endpoint fetch and verify server-side hash/length.
   *
   * Retryability is per failure mode, not per call: transport failures and
   * 5xx are transient, but a checksum or length mismatch is a deterministic
   * statement about the bytes on disk. Retrying those would only delay a
   * real corruption report.
   */
  private async finishAndVerify(
    finishUrl: string,
    sha256: string,
    total: number,
    alg: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const link = linkAbortWithTimeout(signal, this.responseTimeoutMs);

    let data: Partial<FinishResponse>;
    try {
      const response = await fetch(finishUrl, {
        method: "GET",
        headers: this.config.headers,
        signal: link.signal,
      });

      if (response.status !== 200) {
        const detail = truncateDetail(await safeReadText(response));
        throw new ChunkUploadError(
          `Failed to finish upload (HTTP ${response.status})` +
            (detail ? `: ${detail}` : ""),
          {
            kind: "http",
            status: response.status,
            retryable: isRetryableStatus(response.status),
            detail,
          },
        );
      }

      try {
        data = (await response.json()) as Partial<FinishResponse>;
      } catch (err) {
        // A body that will not parse is usually a truncated response, which
        // another attempt can fix.
        throw new ChunkUploadError(
          "Failed to finish upload: malformed response body",
          { kind: "network", retryable: true, cause: err },
        );
      }
    } catch (err) {
      if (err instanceof ChunkUploadError) throw err;

      if (link.timedOut) {
        throw new ChunkUploadError("Failed to finish upload: timed out", {
          kind: "timeout",
          retryable: true,
          cause: err,
        });
      }

      if (this.aborted || signal?.aborted) {
        throw new ChunkUploadError("Upload aborted", {
          kind: "abort",
          retryable: false,
          cause: err,
        });
      }

      throw new ChunkUploadError(
        `Failed to finish upload: ${err instanceof Error ? err.message : String(err)}`,
        { kind: "network", retryable: true, cause: err },
      );
    } finally {
      link.dispose();
    }

    if (typeof data.hash !== "string" || typeof data.length !== "number") {
      throw new ChunkUploadError("No hash returned from server", {
        kind: "http",
        status: 200,
        retryable: false,
      });
    }

    const serverHash = formatHashFromApi(data.hash, alg);

    if (data.length !== total) {
      throw new ChunkUploadError(
        `Uploaded length mismatch after upload. Expected ${total}, got ${data.length}`,
        { kind: "http", status: 200, retryable: false },
      );
    }

    if (serverHash !== sha256) {
      throw new ChunkUploadError(
        `Checksum mismatch after upload. Expected ${sha256}, got ${serverHash}`,
        { kind: "http", status: 200, retryable: false },
      );
    }

    return serverHash;
  }

  /**
   * Upload a file in chunks.
   * @param file The file to upload.
   * @param size The size of each chunk. -1 means upload in a single chunk.
   * @param _overwrite Ignored. Every call uploads to a fresh staging path, so
   * the client always sends ?create=1. Kept for signature compatibility.
   * @returns The staging upload ID used in the upload URL path: base64url(sha256)
   * followed by `.` and a 16-character random suffix, unique per call.
   */
  async upload(file: File, size: number, _overwrite = false): Promise<string> {
    this.aborted = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const isUploadSingleChunk = size === -1 || size >= file.size;
    const chunkSize = isUploadSingleChunk ? file.size : size;

    let { upload, finish } = this.config.endpoints;
    const alg = this.config.alg || DEFAULT_HASH_ALG;

    const total = file.size;

    this.reportProgress(
      {
        uploaded: 0,
        total,
        state: UploadState.Initializing,
      },
      true,
    );

    // compute file hash (base64)
    let sha256: string;
    try {
      sha256 = await this.computeHash(file, alg, signal);
    } catch (err) {
      this.reportProgress(
        { uploaded: 0, total, state: UploadState.Error },
        true,
      );
      throw err;
    }

    // An abort during hashing gets no id: no staging file exists to clean up.
    if (this.aborted || signal.aborted) {
      this.reportProgress(
        { uploaded: 0, total, state: UploadState.Error },
        true,
      );
      throw new ChunkUploadError("Upload aborted", {
        kind: "abort",
        retryable: false,
      });
    }

    // The upload_id is a URL path segment, so its hash part is base64url.
    // The random suffix gives each call its own staging path, even for
    // identical content.
    //
    // The compare value (`sha256`) stays in std-base64 because that's what
    // the daemon emits in the `finish` response — see WEB-1549.
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const uploadId = `${toBase64Url(sha256)}.${toBase64Url(bytesToBase64(nonce))}`;
    upload = upload.replace("{upload_id}", uploadId);

    const url = new URL(upload, window.location.origin);
    url.searchParams.set("create", "1");
    upload = url.toString();

    finish = finish.replace("{upload_id}", uploadId);

    this.reportProgress(
      {
        uploaded: 0,
        total,
        state: UploadState.Uploading,
      },
      true,
    );

    try {
      return await this.runChunksAndFinish(
        file,
        chunkSize,
        upload,
        finish,
        sha256,
        uploadId,
      );
    } catch (err) {
      if (err instanceof ChunkUploadError) err.uploadId = uploadId;
      throw err;
    }
  }

  private async runChunksAndFinish(
    file: File,
    chunkSize: number,
    upload: string,
    finish: string,
    sha256: string,
    uploadId: string,
  ): Promise<string> {
    const total = file.size;
    let uploaded = 0;
    const signal = this.abortController.signal;
    const alg = this.config.alg || DEFAULT_HASH_ALG;

    const chunks = file.size === 0 ? 1 : Math.ceil(file.size / chunkSize);

    // track progress per chunk for smooth overall progress
    const progressPerChunk: number[] = new Array(chunks).fill(0);

    for (let i = 0; i < chunks; i++) {
      if (this.aborted) break;

      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const chunk = file.slice(start, end);
      const chunkLength = end - start;

      const headers: Record<string, string> = {
        ...(this.config.headers as Record<string, string>),
      };

      // If multiple chunks, Range header should be inclusive: start - (end - 1)
      if (chunks > 1) {
        headers["Range"] = `bytes=${start}-${end - 1}`;
      }

      try {
        await this.runWithRetries(
          async () => {
            // Reset partial progress for this chunk before (re)trying so
            // a previously-aborted chunk does not double-count its bytes.
            progressPerChunk[i] = 0;

            await this.uploadChunk(
              upload,
              chunk,
              headers,
              i,
              chunkLength,
              progressPerChunk,
              total,
              signal,
            );
          },
          {
            signal,
            maxAttempts: this.maxChunkRetries,
            chunkIndex: i,
            phase: "chunk",
          },
        );
      } catch (chunkErr) {
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        throw chunkErr;
      }
    }

    if (this.aborted) {
      this.reportProgress(
        {
          uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
          total,
          state: UploadState.Error,
        },
        true,
      );
      throw new ChunkUploadError("Upload aborted during chunk upload", {
        kind: "abort",
        retryable: false,
      });
    }

    try {
      // ensure we mark fully uploaded
      uploaded = total;
      this.reportProgress(
        { uploaded, total, state: UploadState.Finishing },
        true,
      );

      // finishAndVerify throws on mismatch; only transient failures retry.
      await this.runWithRetries(
        () => this.finishAndVerify(finish, sha256, total, alg, signal),
        {
          signal,
          maxAttempts: this.maxFinishRetries,
          chunkIndex: NOT_A_CHUNK,
          phase: "finish",
        },
      );

      if (this.config.onFinalize) {
        // Pass the std-base64 SHA-256 (not the base64url path identifier).
        //
        // Deliberately NOT retried: the panel's finalize moves the staged
        // upload to its destination, which is not idempotent. A retry after
        // a move that actually succeeded but whose response was lost would
        // report a spurious failure for a file that landed correctly.
        await this.config.onFinalize(sha256);
      }

      this.reportProgress(
        {
          uploaded: total,
          total,
          state: UploadState.Done,
        },
        true,
      );
    } catch (err) {
      this.reportProgress({ uploaded, total, state: UploadState.Error }, true);

      // Preserve the typed failure so callers keep the status and the retry
      // verdict. Only untyped throws (e.g. from a consumer's onFinalize) get
      // wrapped, and their message is carried through verbatim.
      if (err instanceof ChunkUploadError) throw err;
      throw new ChunkUploadError(
        `Failed to upload file: ${err instanceof Error ? err.message : String(err)}`,
        { kind: "unknown", retryable: false, cause: err },
      );
    }

    return uploadId;
  }
}
