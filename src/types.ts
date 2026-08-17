export interface Endpoints {
  upload: string;
  finish: string;
}

/**
 * Response body returned by the `finish` endpoint.
 * The client compares these against the locally computed checksum and
 * the original `file.size` to verify integrity end-to-end.
 *
 *  - `hash`   — server-side digest of the assembled upload. May be sent
 *               prefixed with the algorithm (e.g. `"sha-256=…"`); the
 *               client strips the prefix before comparing.
 *  - `length` — total bytes stored by the server. MUST equal the size
 *               of the uploaded file (0 is a valid value for empty
 *               files).
 */
export interface FinishResponse {
  hash: string;
  length: number;
}

export interface RequestInitOptions {
  body?: {
    [key: string]: any;
  };
}

/**
 * Which stage of an upload a retry belongs to. `"chunk"` re-sends bytes;
 * `"finish"` re-asks the server to verify what it stored.
 */
export type RetryPhase = "chunk" | "finish";

export interface ChunkRetryInfo {
  /** Zero-based chunk index, or `-1` when `phase` is not `"chunk"`. */
  chunkIndex: number;
  attempt: number;
  maxAttempts: number;
  error: Error;
  willRetryInMs: number;
  /**
   * Optional for backward compatibility with consumers written before the
   * `finish` phase could retry. Absent means `"chunk"`.
   */
  phase?: RetryPhase;
}

export interface ChunkedUploaderClientProps {
  endpoints: Endpoints;
  /**
   * Called after `finish` succeeds and the server hash has been verified.
   * Receives the **std-base64** SHA-256 of the file (the same value that
   * the server reports in `FinishResponse.hash`). This is **not** the
   * base64url path identifier used in URLs or returned by `upload()`.
   */
  onFinalize?: (sha256: string) => Promise<void>;
  headers?: HeadersInit;
  initOptions?: RequestInitOptions;
  alg?: "SHA-256";
  /**
   * Maximum number of attempts per chunk on retryable errors.
   * The first call counts as attempt 1, so a value of 10 means
   * 1 initial attempt + 9 retries. Default: 10.
   * Set to 1 to disable retries.
   */
  maxChunkRetries?: number;
  /**
   * Maximum number of attempts for the `finish` verification call.
   * Default: 3.
   *
   * Lower than `maxChunkRetries` on purpose — re-sending a 25 MiB chunk is
   * expensive and worth ten tries, re-asking the daemon for a hash is not.
   * Only transient failures (5xx, network, timeout) consume an attempt; a
   * checksum or length mismatch is deterministic and fails immediately.
   */
  maxFinishRetries?: number;
  /**
   * Delay between retry attempts, in milliseconds.
   * The delay is cancellable via abort. Default: 10000 (10s).
   */
  chunkRetryDelayMs?: number;
  /**
   * Optional callback fired before each retry attempt — useful for
   * surfacing "Retrying chunk N (attempt X/Y)" in the UI.
   */
  onChunkRetry?: (info: ChunkRetryInfo) => void;
  /**
   * How long a chunk may make **no upload progress at all** before the
   * attempt is aborted and retried, in milliseconds. Default: 60000 (60s).
   *
   * This is deliberately a *stall* budget, not a wall-clock deadline: the
   * timer is re-armed on every `upload.onprogress` tick, so it is
   * independent of the connection's bandwidth. A 25 MiB chunk crawling
   * over a 1 Mbit/s link keeps resetting it and is never killed; a
   * half-open connection where nothing moves is caught.
   *
   * Set to `0` to disable.
   */
  stallTimeoutMs?: number;
  /**
   * How long to wait for the server's response **after** the request body
   * has been fully handed to the transport, in milliseconds.
   * Default: 300000 (5 min).
   *
   * Generous on purpose. `upload.onprogress` reports bytes written to the
   * socket buffer, not bytes acknowledged by the server, so a small chunk
   * can report 100% while still in flight — a tight budget here would abort
   * healthy uploads on slow links. The point is to bound a connection that
   * will *never* answer, not to enforce a latency SLO. Tighten only with
   * telemetry in hand.
   *
   * Set to `0` to disable.
   */
  responseTimeoutMs?: number;
  /**
   * File size above which the checksum is computed incrementally instead of
   * by reading the whole file into an ArrayBuffer. Default: 67108864 (64 MB).
   *
   * `crypto.subtle.digest` is one-shot, so hashing a multi-gigabyte upload
   * the ordinary way allocates a buffer the size of the file. Below this
   * threshold that is cheap and WebCrypto is the faster implementation;
   * above it the streaming hasher keeps only `hashSliceBytes` resident.
   *
   * Both paths produce identical digests — the threshold is a
   * memory/speed trade-off, never a correctness one. Set to `0` to always
   * use WebCrypto.
   */
  hashStreamingThresholdBytes?: number;
  /**
   * How much of the file is read at a time while hashing incrementally.
   * Default: 8388608 (8 MB). Values <= 0 fall back to the default.
   */
  hashSliceBytes?: number;
  /**
   * Minimum gap between progress callbacks, in milliseconds. Default: 1000.
   *
   * Terminal and important states (`Initializing`, `Finishing`, `Done`,
   * `Error`) always report immediately and ignore this.
   */
  progressReportIntervalMs?: number;
  /**
   * Report progress early when at least this many bytes have moved since
   * the last callback, regardless of `progressReportIntervalMs`.
   * Default: 1000000 (1 MB).
   */
  progressReportBytes?: number;
}

export enum UploadState {
  Initializing = "initializing",
  Uploading = "uploading",
  Finishing = "finishing",
  Error = "error",
  Done = "done",
}

export interface ProgressState {
  uploaded: number;
  total: number;
  state: UploadState;
  currentChunkSize?: number;
}
