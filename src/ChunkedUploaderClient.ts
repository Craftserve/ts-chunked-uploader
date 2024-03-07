interface Endpoints {
  init: string;
  upload: string;
  finish: string;
}

interface ChunkedUploaderClientProps {
  endpoints: Endpoints;
  headers?: HeadersInit;
}

export class ChunkedUploaderClient {
  private config: ChunkedUploaderClientProps;

  constructor(config: ChunkedUploaderClientProps) {
    this.config = config;
  }

  async upload(file: File, chunkSize: number): Promise<string> {
    let { init, upload, finish } = this.config.endpoints;

    const initResponse = await fetch(init, {
      method: "POST",
      headers: this.config.headers,
      body: JSON.stringify({ file_size: file.size }),
    });

    if (initResponse.status !== 201) {
      throw new Error("Failed to initialize upload");
    }

    let upload_id;
    try {
      const data = await initResponse.json();
      upload_id = data.upload_id;
    } catch (error) {
      throw new Error("Failed to parse upload_id");
    }

    if (!upload.includes("{upload_id}") || !finish.includes("{upload_id}")) {
      throw new Error("Invalid endpoint configuration");
    }

    upload = upload.replace("{upload_id}", upload_id);
    finish = finish.replace("{upload_id}", upload_id);

    const chunks = Math.ceil(file.size / chunkSize);
    const promises: Promise<Response>[] = [];

    for (let i = 0; i < chunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const chunk = file.slice(start, end);
      const formData = new FormData();
      formData.append("file", chunk);

      promises.push(
        new Promise((resolve, reject) => {
          fetch(upload, {
            method: "POST",
            headers: {
              ...this.config.headers,
              Range: `bytes=${start}-${end}`,
            },
            body: formData,
          })
            .then((res) => {
              resolve(res);
            })
            .catch((err) => {
              console.error(err);
              reject(err);
            });
        })
      );
    }

    const sha256 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target.result;
        const hash = crypto.subtle.digest("SHA-256", buffer as ArrayBuffer);
        hash
          .then((res) => {
            const hashArray = Array.from(new Uint8Array(res));
            const hashHex = hashArray
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            resolve(hashHex);
          })
          .catch((err) => {
            console.error(err);
            throw new Error("Failed to calculate checksum");
          });
      };

      reader.onerror = (e) => {
        throw new Error("Failed to read file: " + reader.error);
      };

      reader.readAsArrayBuffer(file);
    });

    let path = "";

    await Promise.all(promises)
      .then(async () => {
        const response = await fetch(finish, {
          method: "POST",
          headers: this.config.headers,
          body: JSON.stringify({ checksum: sha256 }),
        });

        if (response.status !== 200) {
          throw new Error("Failed to finish upload. Checksum mismatch.");
        }

        const data = await response.json();
        if (data.path) {
          path = data.path;
        }
      })
      .catch((err) => {
        console.error(err);
        throw new Error("Failed to upload file: " + err);
      });

    return path;
  }
}
