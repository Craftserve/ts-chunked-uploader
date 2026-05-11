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

export interface ChunkRetryInfo {
    chunkIndex: number;
    attempt: number;
    maxAttempts: number;
    error: Error;
    willRetryInMs: number;
}

export interface ChunkedUploaderClientProps {
    endpoints: Endpoints;
    onFinalize?: (upload_id: string) => Promise<void>;
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
     * Delay between chunk retry attempts, in milliseconds.
     * The delay is cancellable via abort. Default: 10000 (10s).
     */
    chunkRetryDelayMs?: number;
    /**
     * Optional callback fired before each retry attempt — useful for
     * surfacing "Retrying chunk N (attempt X/Y)" in the UI.
     */
    onChunkRetry?: (info: ChunkRetryInfo) => void;
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
