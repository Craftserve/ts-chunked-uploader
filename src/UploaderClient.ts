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

    constructor(config: ChunkedUploaderClientProps) {
        this.config = config;
    }

    onprogress(cb: (state: ProgressState) => void): () => void {
        this.progressCallback = cb;

        cb(this.lastProgress);
        return () => {
            if (this.progressCallback === cb) {
                this.progressCallback = undefined;
            }
        };
    }

    private reportProgress(state: ProgressState) {
        this.lastProgress = state;
        try {
            if (this.progressCallback) this.progressCallback(state);
        } catch (e) {
            console.error("progress callback error:", e);
        }
    }

    abort() {
        this.aborted = true;
        if (this.abortController) {
            this.abortController.abort();
        }

        this.reportProgress({
            uploaded: this.lastProgress.uploaded,
            total: this.lastProgress.total,
            state: UploadState.Error,
        });
    }

    async upload(file: File, chunkSize: number): Promise<string> {
        this.aborted = false;
        this.abortController = new AbortController();

        let { upload, finish } = this.config.endpoints;
        this.abortController = new AbortController();

        const total = file.size;
        let uploaded = 0;

        this.reportProgress({
            uploaded: 0,
            total,
            state: UploadState.Initializing,
        });

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
                        this.reportProgress({
                            uploaded,
                            total,
                            state: UploadState.Error,
                        });
                        reject(
                            new Error("Failed to calculate checksum: " + err)
                        );
                    });
            };

            reader.onerror = () => {
                this.reportProgress({
                    uploaded,
                    total,
                    state: UploadState.Error,
                });
                reject(new Error("Failed to read file: " + reader.error));
            };

            try {
                reader.readAsArrayBuffer(file);
            } catch (err) {
                this.reportProgress({
                    uploaded,
                    total,
                    state: UploadState.Error,
                });
                reject(err);
            }
        });

        const upload_id = sha256;

        this.reportProgress({
            uploaded: 0,
            total,
            state: UploadState.Uploading,
        });

        const chunks = Math.ceil(file.size / chunkSize);
        const promises: Promise<void>[] = [];

        for (let i = 0; i < chunks; i++) {
            if (this.aborted) break;

            const start = i * chunkSize;
            const end = Math.min(file.size, start + chunkSize);
            const chunk = file.slice(start, end);
            const chunkLength = end - start;

            const formData = new FormData();
            formData.append("file", chunk);

            const p = fetch(upload, {
                method: "APPEND",
                headers: {
                    ...this.config.headers,
                    Range: `offset=${start}-${end}`,
                },
                body: formData,
                signal: this.abortController.signal,
            })
                .then((res) => {
                    if (!res.ok) {
                        throw new Error(
                            `Chunk upload failed with status ${res.status}`
                        );
                    }

                    uploaded += chunkLength;

                    if (uploaded > total) uploaded = total;
                    this.reportProgress({
                        uploaded,
                        total,
                        state: UploadState.Uploading,
                    });
                })
                .catch((err) => {
                    if (this.aborted) {
                        this.reportProgress({
                            uploaded,
                            total,
                            state: UploadState.Error,
                        });
                        throw new Error("Upload aborted");
                    }
                    this.reportProgress({
                        uploaded,
                        total,
                        state: UploadState.Error,
                    });
                    throw err;
                });

            promises.push(p);
        }

        if (this.aborted) {
            this.reportProgress({ uploaded, total, state: UploadState.Error });
            throw new Error("Upload aborted during checksum calculation");
        }

        let hash = "";

        try {
            await Promise.all(promises);

            if (this.aborted) {
                this.reportProgress({
                    uploaded,
                    total,
                    state: UploadState.Error,
                });
                throw new Error("Upload aborted during chunk upload");
            }

            uploaded = total;
            this.reportProgress({
                uploaded,
                total,
                state: UploadState.Finishing,
            });

            const response = await fetch(finish, {
                method: "GET",
                headers: this.config.headers,
                signal: this.abortController.signal,
            });

            if (response.status !== 201) {
                this.reportProgress({
                    uploaded,
                    total,
                    state: UploadState.Error,
                });
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
                throw new Error("Checksum mismatch after upload");
            }

            if (data.length !== total) {
                throw new Error("Uploaded length mismatch after upload");
            }

            if (this.config.onFinalize) {
                await this.config.onFinalize;
            }

            this.reportProgress({
                uploaded: total,
                total,
                state: UploadState.Done,
            });
        } catch (err) {
            this.reportProgress({ uploaded, total, state: UploadState.Error });
            throw new Error("Failed to upload file: " + err);
        }

        return hash;
    }
}
