import { formatHashFromApi } from "./helpers/formatHash";
import {
  ChunkedUploaderClientProps,
  ChunkRetryInfo,
  FinishResponse,
  ProgressState,
  UploadState,
} from "./types";

const DEFAULT_HASH_ALG = "sha-256";
const DEFAULT_MAX_CHUNK_RETRIES = 10;
const DEFAULT_CHUNK_RETRY_DELAY_MS = 10_000;

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

  // ---- new fields for throttling ----
  private lastProgressReportTime: number = 0;
  private lastReportedUploaded: number = 0;
  private progressIntervalMs: number;
  private progressBytesThreshold: number;
  // ------------------------------------

  // ---- chunk retry config ----
  private maxChunkRetries: number;
  private chunkRetryDelayMs: number;
  // ----------------------------

  constructor(config: ChunkedUploaderClientProps) {
    this.config = config;

    // Allow optional overrides in config (no type change required at types file):
    const cfgAny = this.config as any;
    this.progressIntervalMs = cfgAny.progressReportIntervalMs ?? 1000; // default 1s
    this.progressBytesThreshold = cfgAny.progressReportBytes ?? 1_000_000; // default 1MB

    this.maxChunkRetries = Math.max(
      1,
      config.maxChunkRetries ?? DEFAULT_MAX_CHUNK_RETRIES,
    );
    this.chunkRetryDelayMs =
      config.chunkRetryDelayMs ?? DEFAULT_CHUNK_RETRY_DELAY_MS;
  }

  /**
   * Sleep for `ms` milliseconds. Resolves when the timer fires; rejects with
   * "Upload aborted" if the abort signal fires first. Used between chunk
   * retry attempts so a user-initiated cancel does not have to wait out the
   * remaining backoff window.
   */
  private delayWithAbort(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Upload aborted"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Upload aborted"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * Decide whether a chunk-upload error is worth retrying.
   *  - Network errors → yes (transient connectivity issue)
   *  - HTTP 5xx       → yes (server hiccup)
   *  - HTTP 4xx       → no  (client-side problem, retrying won't help)
   *  - Aborts         → no  (user/system explicitly stopped us)
   */
  private isRetryableChunkError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? "");

    if (/aborted/i.test(msg)) return false;

    if (/Network error during upload/i.test(msg)) return true;

    const m = /Chunk upload failed with status (\d+)/.exec(msg);
    if (m) {
      const status = Number(m[1]);
      return status >= 500 && status < 600;
    }

    // Unknown errors (e.g. xhr.send threw): treat as transient and retry.
    return true;
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

  /**
   * Compute checksum of the whole file (base64 of raw digest bytes).
   */
  private async computeHash(file: File, alg: string): Promise<string> {
    // Normalize algorithm for Web Crypto (e.g. 'sha-256' -> 'SHA-256').
    // Web Crypto expects identifiers like "SHA-256".
    const cryptoAlg = alg.toUpperCase();

    try {
      const buffer = await file.arrayBuffer();
      const digest = await crypto.subtle.digest(cryptoAlg, buffer);
      const hashArray = Array.from(new Uint8Array(digest));
      // convert to binary string then to base64
      let binary = "";
      for (let i = 0; i < hashArray.length; i++) {
        binary += String.fromCharCode(hashArray[i]);
      }
      return btoa(binary);
    } catch (err) {
      throw new Error("Failed to calculate checksum: " + err);
    }
  }

  /**
   * Upload a single chunk using XHR to preserve upload progress events.
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
      console.log("Starting upload of chunk", i, "to", uploadUrl);
      const xhr = new XMLHttpRequest();
      let listenerAdded = false;

      const onAbort = () => {
        try {
          xhr.abort();
        } catch {
          console.error("Failed to abort xhr");
        }
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        listenerAdded = true;
      }

      xhr.open("PUT", uploadUrl, true);

      // credentials handling - preserve previous behaviour
      const cfgAny = this.config as any;
      const maybeCredentials = (cfgAny.headers &&
        (cfgAny.headers as any).credentials) as string | undefined;
      if (maybeCredentials && maybeCredentials === "include") {
        xhr.withCredentials = true;
      }

      for (const [k, v] of Object.entries(headers)) {
        if (!v) continue;
        const lower = k.toLowerCase();
        if (lower === "content-type" || lower === "credentials") continue;
        try {
          xhr.setRequestHeader(k, v);
        } catch {}
      }

      xhr.upload.onprogress = (ev) => {
        // ev.loaded should be present; clamp to chunkLength.
        const reportedLoaded = typeof ev.loaded === "number" ? ev.loaded : 0;
        const loaded = Math.min(chunkLength, reportedLoaded);

        // Do not decrease previously recorded progress for this chunk (prevents regressions / double-counting issues)
        progressPerChunk[i] = Math.max(progressPerChunk[i] || 0, loaded);

        const uploaded = Math.min(
          total,
          progressPerChunk.reduce((a, b) => a + b, 0),
        );

        this.reportProgress({
          uploaded,
          total,
          state: UploadState.Uploading,
          currentChunkSize: chunkLength,
        });
      };

      xhr.onload = () => {
        // remove listener if still present
        if (signal && listenerAdded) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {}
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          // ensure chunk considered fully uploaded
          progressPerChunk[i] = chunkLength;
          const uploaded = Math.min(
            total,
            progressPerChunk.reduce((a, b) => a + b, 0),
          );

          this.reportProgress({
            uploaded,
            total,
            state: UploadState.Uploading,
            currentChunkSize: chunkLength,
          });

          resolve();
        } else {
          this.reportProgress(
            {
              uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
              total,
              state: UploadState.Error,
            },
            true,
          );
          reject(new Error(`Chunk upload failed with status ${xhr.status}`));
        }
      };

      xhr.onerror = () => {
        if (signal && listenerAdded) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {}
        }
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        reject(new Error("Network error during upload"));
      };

      xhr.onabort = () => {
        if (signal && listenerAdded) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {}
        }
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        reject(new Error("Upload aborted"));
      };

      try {
        xhr.setRequestHeader(
          "Content-type",
          // keep previous behaviour (fallback to octet-stream)
          (this.config.headers as Record<string, string>)["Content-type"] ||
            (chunk instanceof File
              ? chunk.type || "application/octet-stream"
              : "application/octet-stream") ||
            (this.config.headers &&
              (this.config.headers as any)["content-type"]) ||
            (chunk instanceof Blob && (chunk as Blob).type) ||
            "application/octet-stream",
        );
      } catch {}

      try {
        xhr.send(chunk);
      } catch (err) {
        if (signal && listenerAdded) {
          try {
            signal.removeEventListener("abort", onAbort);
          } catch {}
        }
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        reject(err);
      }
    });
  }

  /**
   * Finish endpoint fetch and verify server-side hash/length
   */
  private async finishAndVerify(
    finishUrl: string,
    sha256: string,
    total: number,
    alg: string,
  ): Promise<string> {
    const response = await fetch(finishUrl, {
      method: "GET",
      headers: this.config.headers,
      signal: this.abortController?.signal,
    });

    if (response.status !== 200) {
      this.reportProgress(
        { uploaded: total, total, state: UploadState.Error },
        true,
      );
      throw new Error(
        "Failed to finish upload. Checksum mismatch or server error.",
      );
    }

    const data = (await response.json()) as Partial<FinishResponse>;

    if (typeof data.hash !== "string" || typeof data.length !== "number") {
      throw new Error("No hash returned from server");
    }

    const serverHash = formatHashFromApi(data.hash, alg);

    if (data.length !== total) {
      throw new Error(
        `Uploaded length mismatch after upload. Expected ${total}, got ${data.length}`,
      );
    }

    if (serverHash !== sha256) {
      throw new Error(
        `Checksum mismatch after upload. Expected ${sha256}, got ${serverHash}`,
      );
    }

    return serverHash;
  }

  /**
   * Upload a file in chunks.
   * @param file The file to upload.
   * @param size The size of each chunk. -1 means upload in a single chunk.
   * @param overwrite Whether to overwrite existing data. Default is false (append).
   * @returns The base64url upload ID (same as used in the upload URL path).
   */
  async upload(file: File, size: number, overwrite = false): Promise<string> {
    this.aborted = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const isUploadSingleChunk = size === -1 || size >= file.size;
    const chunkSize = isUploadSingleChunk ? file.size : size;

    let { upload, finish } = this.config.endpoints;
    const alg = this.config.alg || DEFAULT_HASH_ALG;

    const total = file.size;
    let uploaded = 0;

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
      sha256 = await this.computeHash(file, alg);
    } catch (err) {
      this.reportProgress({ uploaded, total, state: UploadState.Error }, true);
      throw err;
    }

    // The upload_id is used as a URL path segment, so it must not contain
    // characters from the standard base64 alphabet that are unsafe in URLs
    // ('+', '/', '='). We derive a base64url variant (RFC 4648 §5) of the
    // SHA-256 specifically for the path identifier.
    //
    // The compare value (`sha256`) stays in std-base64 because that's what
    // the daemon emits in the `finish` response — see WEB-1549.
    const uploadId = sha256
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    upload = upload.replace("{upload_id}", uploadId);

    if (overwrite === false) {
      const url = new URL(upload, window.location.origin);
      url.searchParams.set("create", "1");
      upload = url.toString();
    }

    finish = finish.replace("{upload_id}", uploadId);

    this.reportProgress(
      {
        uploaded: 0,
        total,
        state: UploadState.Uploading,
      },
      true,
    );

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

      // ---- per-chunk retry loop ----
      // Wraps the single uploadChunk() call. The first call counts as
      // attempt 1; transient failures (network errors, 5xx) are retried
      // up to `maxChunkRetries` total attempts with `chunkRetryDelayMs`
      // between attempts. The delay is cancellable via abort.
      let chunkErr: unknown = null;

      for (let attempt = 1; attempt <= this.maxChunkRetries; attempt++) {
        if (this.aborted || signal.aborted) {
          chunkErr = new Error("Upload aborted");
          break;
        }

        try {
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

          chunkErr = null;
          break; // chunk uploaded successfully
        } catch (err) {
          chunkErr = err;

          // Stop immediately on abort or non-retryable errors.
          if (
            this.aborted ||
            signal.aborted ||
            !this.isRetryableChunkError(err)
          ) {
            break;
          }

          // Out of attempts → give up and propagate.
          if (attempt >= this.maxChunkRetries) {
            break;
          }

          // Surface the retry to the caller (UI feedback hook).
          if (this.config.onChunkRetry) {
            const info: ChunkRetryInfo = {
              chunkIndex: i,
              attempt,
              maxAttempts: this.maxChunkRetries,
              error: err instanceof Error ? err : new Error(String(err)),
              willRetryInMs: this.chunkRetryDelayMs,
            };
            try {
              this.config.onChunkRetry(info);
            } catch (cbErr) {
              console.error("onChunkRetry callback error:", cbErr);
            }
          }

          // Wait the configured backoff before the next attempt.
          // If abort fires during the wait, propagate that abort
          // instead of the underlying chunk error.
          try {
            await this.delayWithAbort(this.chunkRetryDelayMs, signal);
          } catch (abortErr) {
            chunkErr = abortErr;
            break;
          }
        }
      }

      if (chunkErr) {
        // ensure we report and cleanup
        this.reportProgress(
          {
            uploaded: progressPerChunk.reduce((a, b) => a + b, 0),
            total,
            state: UploadState.Error,
          },
          true,
        );
        // propagate error
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
      throw new Error("Upload aborted during chunk upload");
    }

    try {
      // ensure we mark fully uploaded
      uploaded = total;
      this.reportProgress(
        { uploaded, total, state: UploadState.Finishing },
        true,
      );

      // finishAndVerify will throw on mismatch
      await this.finishAndVerify(finish, sha256, total, alg);

      if (this.config.onFinalize) {
        // Pass the std-base64 SHA-256 (not the base64url path identifier).
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
      this.reportProgress(
        { uploaded: uploaded, total, state: UploadState.Error },
        true,
      );
      throw new Error("Failed to upload file: " + err);
    }

    return uploadId;
  }
}
