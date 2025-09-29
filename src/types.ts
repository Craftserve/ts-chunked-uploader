export interface Endpoints {
    upload: string;
    finish: string;
}

export interface RequestInitOptions {
    body?: {
        [key: string]: any;
    };
}

export interface ChunkedUploaderClientProps {
    endpoints: Endpoints;
    onFinalize?: (upload_id: string) => Promise<void>;
    headers?: HeadersInit;
    initOptions?: RequestInitOptions;
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
}
