/**
 * Typed failures for the upload pipeline.
 *
 * Before this existed, retryability was decided by running regexes over
 * `Error.message` — the HTTP status was recovered by parsing back a string
 * the uploader itself had produced two frames earlier. That coupled control
 * flow to message wording (any daemon error body containing "aborted"
 * flipped a retryable failure into a permanent one) and silently discarded
 * the status, so an expired token (401), a busy daemon (503) and a full
 * disk (507) were indistinguishable downstream.
 *
 * Every failure the uploader raises is now a `ChunkUploadError` carrying the
 * status, a machine-readable `kind`, and an explicit `retryable` verdict.
 */

export type ChunkUploadFailureKind =
  /** Server answered with a status outside 2xx. */
  | "http"
  /** Transport-level failure — connection refused, DNS, TLS, reset. */
  | "network"
  /** No bytes moved / no response within the configured budget. */
  | "timeout"
  /** Caller (or `abort()`) stopped the upload on purpose. */
  | "abort"
  /** Anything we could not classify (e.g. `xhr.send()` threw). */
  | "unknown";

export interface ChunkUploadErrorOptions {
  kind: ChunkUploadFailureKind;
  retryable: boolean;
  /** HTTP status, when the failure came from a response. */
  status?: number;
  /** Truncated response body, kept for diagnostics. */
  detail?: string;
  cause?: unknown;
  /** The staging id the failing attempt was using, if one had been assigned. */
  uploadId?: string;
}

/**
 * How many characters of a failing response body to keep on the error.
 * Enough to carry a daemon error envelope (`{"error":"...","event_id":"..."}`)
 * without pasting a whole HTML error page into a log line.
 */
const DETAIL_MAX_CHARS = 200;

export class ChunkUploadError extends Error {
  readonly kind: ChunkUploadFailureKind;
  readonly retryable: boolean;
  readonly status?: number;
  readonly detail?: string;
  readonly cause?: unknown;
  /** Set by upload() on every error thrown after the id exists. */
  uploadId?: string;

  constructor(message: string, options: ChunkUploadErrorOptions) {
    super(message);
    this.name = "ChunkUploadError";
    this.kind = options.kind;
    this.retryable = options.retryable;
    this.status = options.status;
    this.detail = options.detail;
    this.cause = options.cause;
    this.uploadId = options.uploadId;

    // `extends Error` loses the prototype link when the consumer compiles
    // this package down to ES5. The package targets ES2015 so this is
    // belt-and-braces, but `instanceof` is load-bearing for retry decisions
    // and a silent `false` here would disable retries entirely.
    Object.setPrototypeOf(this, ChunkUploadError.prototype);
  }
}

/** Trim a response body down to something safe to keep on an error. */
export function truncateDetail(body: string | null | undefined): string | undefined {
  if (!body) return undefined;
  const trimmed = body.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > DETAIL_MAX_CHARS
    ? `${trimmed.slice(0, DETAIL_MAX_CHARS)}…`
    : trimmed;
}

/**
 * Whether a given HTTP status is worth another attempt.
 *
 * The general rule is "5xx yes, 4xx no", with four deliberate exceptions:
 *
 *  - **507 Insufficient Storage** — the volume is full. Retrying ten times
 *    with a ten-second gap turns an instant, actionable "not enough space"
 *    into a 90-second stall that fails anyway.
 *  - **501 Not Implemented** — the daemon does not support the call and will
 *    not start to a second later.
 *  - **408 Request Timeout** — the server gave up waiting on a slow body;
 *    a fresh attempt is exactly the right response.
 *  - **429 Too Many Requests** — explicit backpressure, meant to be retried.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status === 501 || status === 507) return false;
  return status >= 500 && status < 600;
}

/**
 * Retry verdict for an arbitrary thrown value.
 *
 * Typed errors answer for themselves. Anything else reaching here did not
 * come from this library's own paths, and the historical default was to
 * treat unknown failures as transient — keep that, so a stray throw from a
 * consumer-supplied callback does not become permanently fatal.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ChunkUploadError) return err.retryable;
  return true;
}
