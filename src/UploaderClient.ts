import {
    ChunkedUploaderClientProps,
    ProgressState,
    UploadState,
} from "./types";

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

    constructor(config: ChunkedUploaderClientProps) {
        this.config = config;

        // Allow optional overrides in config (no type change required at types file):
        const cfgAny = this.config as any;
        this.progressIntervalMs = cfgAny.progressReportIntervalMs ?? 1000; // default 1s
        this.progressBytesThreshold = cfgAny.progressReportBytes ?? 1_000_000; // default 1MB
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
        console.log("report progress", state);

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
        const bytesSinceLast = Math.max(
            0,
            uploaded - this.lastReportedUploaded
        );

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
            true
        );
    }

    /**
     * Upload a file in chunks.
     * @param file The file to upload.
     * @param size The size of each chunk. -1 means upload in a single chunk.
     * @param overwrite Whether to overwrite existing data. Default is false (append).
     * @returns The upload ID.
     */
    async upload(file: File, size: number, overwrite = false): Promise<string> {
        this.aborted = false;
        this.abortController = new AbortController();
        const isUploadSingleChunk = size === -1 || size >= file.size;
        const chunkSize = isUploadSingleChunk ? file.size : size;

        let { upload, finish } = this.config.endpoints;
        // single abortController is enough for all XHRs/fetches
        this.abortController = new AbortController();

        const total = file.size;
        let uploaded = 0;

        this.reportProgress(
            {
                uploaded: 0,
                total,
                state: UploadState.Initializing,
            },
            true
        );

        const sha256: string = await new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                const buffer = e.target!.result;
                crypto.subtle
                    .digest("SHA-256", buffer as ArrayBuffer)
                    .then((res) => {
                        const hashArray = Array.from(new Uint8Array(res));
                        const hashHex = hashArray
                            .map((b) => b.toString(16).padStart(2, "0"))
                            .join("");
                        resolve(hashHex);
                    })
                    .catch((err) => {
                        this.reportProgress(
                            {
                                uploaded,
                                total,
                                state: UploadState.Error,
                            },
                            true
                        );
                        reject(
                            new Error("Failed to calculate checksum: " + err)
                        );
                    });
            };

            reader.onerror = () => {
                this.reportProgress(
                    {
                        uploaded,
                        total,
                        state: UploadState.Error,
                    },
                    true
                );
                reject(new Error("Failed to read file: " + reader.error));
            };

            try {
                reader.readAsArrayBuffer(file);
            } catch (err) {
                this.reportProgress(
                    {
                        uploaded,
                        total,
                        state: UploadState.Error,
                    },
                    true
                );
                reject(err);
            }
        });

        const upload_id = sha256;

        // Create URL
        upload = upload.replace("{upload_id}", upload_id);

        if (overwrite === false) {
            const url = new URL(upload, window.location.origin);
            url.searchParams.set("create", "1");
            upload = url.toString();
        }

        finish = finish.replace("{upload_id}", upload_id);

        this.reportProgress(
            {
                uploaded: 0,
                total,
                state: UploadState.Uploading,
            },
            true
        );

        const chunks = Math.ceil(file.size / chunkSize);
        const promises: Promise<void>[] = [];

        console.log(
            "running upload with chunk size: v3",
            chunkSize,
            isUploadSingleChunk,
            chunks
        );

        // track progress per chunk for smooth overall progress
        const progressPerChunk: number[] = new Array(chunks).fill(0);

        for (let i = 0; i < chunks; i++) {
            if (this.aborted) break;

            const start = i * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunk = file.slice(start, end);
            const chunkLength = end - start;

            // const formData = new FormData();
            // const chunkFile = new File([chunk], file.name, { type: file.type });
            // formData.append("file", chunk);

            // clone headers
            const headers: Record<string, string> = {
                ...(this.config.headers as Record<string, string>),
            };

            // Create XHR-based promise for the chunk
            const p = new Promise<void>((resolve, reject) => {
                // If aborted already, don't start
                if (this.aborted) {
                    this.reportProgress(
                        { uploaded, total, state: UploadState.Error },
                        true
                    );
                    return reject(new Error("Upload aborted"));
                }

                const xhr = new XMLHttpRequest();

                // Integrate AbortController with XHR
                const onAbort = () => {
                    try {
                        xhr.abort();
                    } catch (e) {}
                };
                if (this.abortController) {
                    try {
                        this.abortController.signal.addEventListener(
                            "abort",
                            onAbort,
                            { once: true }
                        );
                    } catch (e) {}
                }

                // open
                xhr.open("PUT", upload, true);

                // If config.headers contains 'credentials' (e.g. "include"), map to xhr.withCredentials
                const cfgAny = this.config as any;
                const maybeCredentials = (cfgAny.headers &&
                    (cfgAny.headers as any).credentials) as string | undefined;
                if (maybeCredentials && maybeCredentials === "include") {
                    xhr.withCredentials = true;
                }

                // Set headers (skip Content-Type and skip 'credentials' pseudo-header)
                try {
                    for (const [k, v] of Object.entries(headers)) {
                        if (!v) continue;
                        const lower = k.toLowerCase();
                        if (lower === "content-type") continue;
                        if (lower === "credentials") continue;
                        try {
                            xhr.setRequestHeader(k, v);
                        } catch (e) {
                            // ignore invalid headers
                        }
                    }
                } catch (e) {
                    // ignore
                }

                if (chunks > 1) {
                    headers["Range"] = `offset=${start}-${end}`;
                }

                // progress event for this chunk
                xhr.upload.onprogress = (ev) => {
                    // ev.loaded = bytes uploaded for this request
                    // clamp to chunkLength if lengthComputable and ev.total equals chunkLength
                    console.log("xhr.upload.onprogress", ev);

                    const loaded = Math.min(
                        chunkLength,
                        ev.lengthComputable ? ev.loaded : ev.loaded
                    );
                    progressPerChunk[i] = loaded;
                    uploaded = progressPerChunk.reduce((a, b) => a + b, 0);
                    if (uploaded > total) uploaded = total;

                    // non-forced update -> will be throttled
                    this.reportProgress({
                        uploaded,
                        total,
                        state: UploadState.Uploading,
                        currentChunkSize: chunkLength,
                    });
                };

                xhr.onload = () => {
                    // remove abort listener
                    if (this.abortController) {
                        try {
                            this.abortController.signal.removeEventListener(
                                "abort",
                                onAbort
                            );
                        } catch (e) {}
                    }

                    if (xhr.status >= 200 && xhr.status < 300) {
                        // ensure this chunk is considered fully uploaded
                        progressPerChunk[i] = chunkLength;
                        uploaded = Math.min(
                            total,
                            progressPerChunk.reduce((a, b) => a + b, 0)
                        );

                        // final per-chunk update after completion (throttled)
                        this.reportProgress({
                            uploaded,
                            total,
                            state: UploadState.Uploading,
                            currentChunkSize: chunkLength,
                        });

                        resolve();
                    } else {
                        this.reportProgress(
                            { uploaded, total, state: UploadState.Error },
                            true
                        );
                        reject(
                            new Error(
                                `Chunk upload failed with status ${xhr.status}`
                            )
                        );
                    }
                };

                xhr.onerror = () => {
                    if (this.abortController) {
                        try {
                            this.abortController.signal.removeEventListener(
                                "abort",
                                onAbort
                            );
                        } catch (e) {}
                    }
                    this.reportProgress(
                        { uploaded, total, state: UploadState.Error },
                        true
                    );
                    reject(new Error("Network error during upload"));
                };

                xhr.onabort = () => {
                    if (this.abortController) {
                        try {
                            this.abortController.signal.removeEventListener(
                                "abort",
                                onAbort
                            );
                        } catch (e) {}
                    }
                    this.reportProgress(
                        { uploaded, total, state: UploadState.Error },
                        true
                    );
                    reject(new Error("Upload aborted"));
                };

                try {
                    xhr.setRequestHeader(
                        "Content-type",
                        file.type || "application/octet-stream"
                    );
                    xhr.send(chunk);
                } catch (err) {
                    if (this.abortController) {
                        try {
                            this.abortController.signal.removeEventListener(
                                "abort",
                                onAbort
                            );
                        } catch (e) {}
                    }
                    this.reportProgress(
                        { uploaded, total, state: UploadState.Error },
                        true
                    );
                    reject(err);
                }
            }).catch((err) => {
                // propagate errors but keep type as Promise<void>
                throw err;
            });

            promises.push(p);
        }

        if (this.aborted) {
            this.reportProgress(
                { uploaded, total, state: UploadState.Error },
                true
            );
            throw new Error("Upload aborted during checksum calculation");
        }

        let hash = "";

        try {
            await Promise.all(promises);

            if (this.aborted) {
                this.reportProgress(
                    {
                        uploaded,
                        total,
                        state: UploadState.Error,
                    },
                    true
                );
                throw new Error("Upload aborted during chunk upload");
            }

            // ensure we mark fully uploaded
            uploaded = total;
            this.reportProgress(
                {
                    uploaded,
                    total,
                    state: UploadState.Finishing,
                },
                true
            );

            const response = await fetch(finish, {
                method: "GET",
                headers: this.config.headers,
                signal: this.abortController?.signal,
            });

            if (response.status !== 200) {
                this.reportProgress(
                    {
                        uploaded,
                        total,
                        state: UploadState.Error,
                    },
                    true
                );
                throw new Error(
                    "Failed to finish upload. Checksum mismatch or server error."
                );
            }

            const data = await response.json();

            if (!data.hash || !data.length) {
                throw new Error("No hash returned from server");
            }

            hash = data.hash;

            if (hash !== sha256) {
                throw new Error(
                    `Checksum mismatch after upload. Expected ${sha256}, got ${hash}`
                );
            }

            if (data.length !== total) {
                throw new Error(
                    `Uploaded length mismatch after upload. Expected ${total}, got ${data.length}`
                );
            }

            if (this.config.onFinalize) {
                await this.config.onFinalize(upload_id);
            }

            this.reportProgress(
                {
                    uploaded: total,
                    total,
                    state: UploadState.Done,
                },
                true
            );
        } catch (err) {
            this.reportProgress(
                { uploaded, total, state: UploadState.Error },
                true
            );
            throw new Error("Failed to upload file: " + err);
        }

        return hash;
    }
}
