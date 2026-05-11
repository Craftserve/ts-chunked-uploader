import { vi } from "vitest";

/**
 * MockXHR — drop-in replacement for XMLHttpRequest that lets tests drive
 * upload progress, success, network error, and abort events deterministically.
 *
 * Each instance is recorded in `MockXHR.instances` so tests can grab the
 * most recent XHR created by the code under test and trigger events on it.
 */
export class MockXHR {
  static instances: MockXHR[] = [];
  static autoComplete: ((xhr: MockXHR) => void) | null = null;

  public upload: { onprogress: ((ev: any) => void) | null } = {
    onprogress: null,
  };
  public onload: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public onabort: (() => void) | null = null;

  public method = "";
  public url = "";
  public async = true;
  public status = 0;
  public responseText = "";
  public withCredentials = false;
  public requestHeaders: Record<string, string> = {};
  public sentBody: any = null;
  public opened = false;
  public sendCalled = false;

  open(method: string, url: string, async = true) {
    this.method = method;
    this.url = url;
    this.async = async;
    this.opened = true;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body: any) {
    this.sendCalled = true;
    this.sentBody = body;
    if (MockXHR.autoComplete) {
      // Defer to allow caller to register listeners.
      queueMicrotask(() => {
        if (MockXHR.autoComplete) MockXHR.autoComplete(this);
      });
    }
  }

  abort() {
    if (this.onabort) this.onabort();
  }

  // Test helpers
  emitProgress(loaded: number, total?: number) {
    if (this.upload.onprogress) {
      this.upload.onprogress({ loaded, total: total ?? loaded });
    }
  }

  finishOK(status = 200) {
    this.status = status;
    if (this.onload) this.onload();
  }

  finishError(status: number) {
    this.status = status;
    if (this.onload) this.onload();
  }

  networkError() {
    if (this.onerror) this.onerror();
  }

  static install() {
    MockXHR.instances = [];
    MockXHR.autoComplete = null;
    const orig = (globalThis as any).XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = function (this: any) {
      const inst = new MockXHR();
      MockXHR.instances.push(inst);
      return inst;
    };
    return () => {
      (globalThis as any).XMLHttpRequest = orig;
    };
  }

  static last(): MockXHR {
    if (MockXHR.instances.length === 0) {
      throw new Error("MockXHR: no instances yet");
    }
    return MockXHR.instances[MockXHR.instances.length - 1];
  }

  static async waitForCount(n: number, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (MockXHR.instances.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `MockXHR.waitForCount: expected ${n}, got ${MockXHR.instances.length} after ${timeoutMs}ms`
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

/**
 * Install a crypto.subtle.digest stub so tests don't need real crypto.
 * The resulting digest is deterministic: first 32 bytes are derived from
 * the input length so different files get different hashes.
 */
export function installCryptoStub() {
  // happy-dom exposes `crypto` via a getter, so we can't reassign the whole
  // object. Patch the `subtle.digest` method in place.
  const subtle = (globalThis as any).crypto?.subtle;
  if (!subtle) {
    throw new Error("installCryptoStub: globalThis.crypto.subtle missing");
  }
  const origDigest = subtle.digest?.bind(subtle);
  subtle.digest = async (_alg: string, buffer: ArrayBuffer) => {
    const out = new Uint8Array(32);
    const view = new Uint8Array(buffer);
    out[0] = view.length & 0xff;
    out[1] = (view.length >> 8) & 0xff;
    out[2] = (view.length >> 16) & 0xff;
    out[3] = view.length > 0 ? view[0] : 0;
    for (let i = 4; i < 32; i++) {
      out[i] = (i + view.length) & 0xff;
    }
    return out.buffer;
  };
  return () => {
    if (origDigest) subtle.digest = origDigest;
  };
}

/**
 * Build a File whose .arrayBuffer() resolves with the given bytes.
 * happy-dom's File doesn't always implement arrayBuffer(), so we override it.
 */
export function makeFile(content: Uint8Array, name = "test.bin"): File {
  // Copy into a fresh ArrayBuffer so types resolve to BlobPart cleanly
  // (Uint8Array<ArrayBufferLike> is not BlobPart-compatible in TS 5+).
  const buf = new ArrayBuffer(content.byteLength);
  new Uint8Array(buf).set(content);
  const file = new File([buf], name, { type: "application/octet-stream" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => buf.slice(0),
    configurable: true,
  });
  Object.defineProperty(file, "slice", {
    value: (start?: number, end?: number) => {
      const s = start ?? 0;
      const e = end ?? content.length;
      const sliced = buf.slice(s, e);
      const blob = new Blob([sliced], { type: file.type });
      Object.defineProperty(blob, "arrayBuffer", {
        value: async () => sliced.slice(0),
        configurable: true,
      });
      return blob;
    },
    configurable: true,
  });
  return file;
}

/**
 * Encode a Uint8Array → base64 the same way UploaderClient.computeHash does
 * (via btoa over a binary string). This lets tests predict the upload_id.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Compute the expected hash for a file of given length, matching the
 * deterministic crypto stub above.
 */
export function expectedHashForFile(length: number, firstByte = 0): string {
  const out = new Uint8Array(32);
  out[0] = length & 0xff;
  out[1] = (length >> 8) & 0xff;
  out[2] = (length >> 16) & 0xff;
  out[3] = length > 0 ? firstByte : 0;
  for (let i = 4; i < 32; i++) {
    out[i] = (i + length) & 0xff;
  }
  return bytesToBase64(out);
}

/**
 * Sleep helper for tests that need to yield to the event loop.
 */
export async function tick(ms = 0): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a fetch() stub that records calls and returns a queued response.
 */
export function installFetchStub() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue: Array<{
    status: number;
    body: any;
    delayMs?: number;
  }> = [];

  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) {
      throw new Error(
        `fetch stub: no queued response for ${url} (call #${calls.length})`
      );
    }
    if (next.delayMs) await tick(next.delayMs);
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body,
    } as Response;
  });

  (globalThis as any).fetch = fn;
  return { calls, queue, fn };
}
