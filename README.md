# @craftserve/ts-chunked-uploader

Biblioteka frontendowa TypeScript do **wysyłania dużych plików w częściach (chunkach)** z raportowaniem postępu, obsługą anulowania oraz weryfikacją integralności danych po stronie serwera.

---

## ✨ Funkcje

- Upload plików w częściach (`chunked upload`)
- Raportowanie postępu (`onprogress`)
- Obsługa anulowania (`abort`)
- Automatyczne obliczanie i weryfikacja sumy kontrolnej (`SHA-256` domyślnie)
- Obsługa throttlingu eventów postępu (limit czasowy i objętościowy)
- Integracja z backendowymi endpointami `upload` i `finish`

---

## 🚀 Instalacja

Wewnątrz projektu korzystającego z bibliotek Craftserve dodaj do `.npmrc`:

```
@craftserve:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Następnie zainstaluj paczkę:

```bash
npm install @craftserve/ts-chunked-uploader
# lub
yarn add @craftserve/ts-chunked-uploader
```

---

## 🧩 Użycie

```ts
import { UploaderClient } from "@craftserve/ts-chunked-uploader";

const uploader = new UploaderClient({
  endpoints: {
    upload: "/api/uploads/{upload_id}/chunk",
    finish: "/api/uploads/{upload_id}/finish",
  },
  headers: {
    Authorization: "Bearer token",
  },
});

uploader.onprogress((state) => {
  console.log("Progress:", state.uploaded, "/", state.total, state.state);
});

const file = document.querySelector("input[type=file]")!.files![0];
await uploader.upload(file, 5 * 1024 * 1024); // wysyłaj w chunkach po 5 MB
```

### Anulowanie uploadu

```ts
setTimeout(() => uploader.abort(), 5000);
```

---

## 🔌 Kontrakt z backendem

Biblioteka nie definiuje endpointów ani ich nie tworzy — jedynie wywołuje dwa
ścieżki podane w `endpoints`. Backend musi zachowywać się następująco:

### `upload` — przesyłanie chunków

- **Metoda:** `PUT`
- **URL:** wzorzec z `{upload_id}`, np. `/api/uploads/{upload_id}/chunk`.
  `{upload_id}` to **base64url** (RFC 4648 §5, bez padding `=`) ze skrótu
  SHA‑256 całego pliku — to jest tylko identyfikator dla URL‑a, nie wartość
  do porównywania (patrz `finish` poniżej).
  W przypadku pierwszego chunka (gdy `overwrite=false`) klient dodaje
  query `?create=1`.
- **Nagłówki:**
  - `Range: bytes=<start>-<end-1>` — **tylko gdy plik jest dzielony na
    wiele chunków**. Dla single‑chunk (`size = -1` albo `size >= file.size`)
    nagłówek `Range` nie jest wysyłany.
  - `Content-Type` — typ pliku albo `application/octet-stream`.
  - Dowolne nagłówki dodatkowe z `config.headers` (np. `Authorization`).
- **Body:** surowe bajty chunka (`Blob`), bez `multipart/form-data`.
- **Odpowiedź:** dowolne `2xx` traktowane jest jako sukces. `4xx` to błąd
  nieretryowalny (klient propaguje wyjątek), `5xx` i błąd sieci są
  retryowane zgodnie z `maxChunkRetries` / `chunkRetryDelayMs`.

### `finish` — weryfikacja i finalizacja

- **Metoda:** `GET`
- **URL:** wzorzec z `{upload_id}`, np. `/api/uploads/{upload_id}/finish`.
- **Odpowiedź:** **`200 OK`** z ciałem JSON o kształcie [`FinishResponse`](./src/types.ts):

  ```ts
  interface FinishResponse {
    hash: string; // skrót pliku po stronie serwera w **standard base64**
    // (alfabet z '+/='). Opcjonalny prefiks algorytmu jest tolerowany,
    // np. "sha-256=…"
    length: number; // liczba zapisanych bajtów; MUSI równać się file.size
    // ─ wartość 0 jest poprawna dla pustego pliku
  }
  ```

  Każdy inny status traktowany jest jako błąd (`Failed to finish upload`).
  Klient porównuje `hash` z lokalnie wyliczonym SHA‑256 w **standard
  base64** (po stripowaniu prefiksu `alg=`) oraz `length` z `file.size`;
  rozbieżność → wyjątek `Checksum mismatch` / `length mismatch`.

> **Uwaga o alfabetach.** Klient celowo używa dwóch kodowań tej samej wartości
> SHA‑256:
>
> - **base64url** w segmencie URL‑a `{upload_id}` — bezpieczne ścieżkowo,
>   bez `+`, `/`, `=`. Ta wartość jest zwracana przez `upload()`.
> - **standard base64** w polu `hash` z `finish` (kontrakt z daemonem) — wartość
>   porównywana lokalnie; przekazywana do `onFinalize` (jeśli skonfigurowane).

### `onFinalize` (opcjonalne)

Jeśli skonfigurowane, jest wywoływane **po** udanej weryfikacji `finish`,
z **standard‑base64 SHA‑256** pliku jako argumentem (wartością z `finish`,
nie z base64url używanym w URL ani zwracanym przez `upload()`). Wyjątek z
callbacka zatrzymuje upload i jest propagowany jako `Failed to upload file: …`.

---

## ⚙️ Konfiguracja

| Parametr                   | Typ                      | Opis                                                            |
| -------------------------- | ------------------------ | --------------------------------------------------------------- |
| `endpoints.upload`         | `string`                 | URL endpointu do wysyłki chunków, np. `/api/upload/{upload_id}` |
| `endpoints.finish`         | `string`                 | URL do weryfikacji i zakończenia uploadu                        |
| `headers`                  | `Record<string, string>` | Dodatkowe nagłówki (np. `Authorization`)                        |
| `alg`                      | `string`                 | Algorytm haszujący, np. `sha-256` (domyślnie)                   |
| `progressReportIntervalMs` | `number`                 | Minimalny odstęp czasu między raportami postępu (ms)            |
| `progressReportBytes`      | `number`                 | Minimalna liczba bajtów między raportami postępu                |
| `onFinalize`               | `() => Promise<void>`    | Opcjonalny callback po zakończeniu uploadu                      |

---

## 📦 Publikacja paczki (GitHub Packages)

### 1. Upewnij się, że `package.json` ma:

```json
{
  "name": "@craftserve/ts-chunked-uploader",
  "version": "1.0.0",
  "publishConfig": {
    "registry": "https://npm.pkg.github.com/"
  }
}
```

### 2. Zaloguj się do GitHub Packages

```bash
npm login --registry=https://npm.pkg.github.com
# lub ustaw w .npmrc token
```

### 3. Zbuduj i opublikuj

```bash
npm run build
npm publish
```

### 4. (Opcjonalnie) Automatyczna publikacja przez GitHub Actions

Utwórz `.github/workflows/publish.yml`:

```yaml
name: Publish @craftserve/ts-chunked-uploader

on:
  push:
    tags:
      - "v*.*.*"

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: "https://npm.pkg.github.com"
      - run: npm ci
      - run: npm run build
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## 🧠 Wskazówki

- Aby opublikować nową wersję, zwiększ wersję w `package.json` i dodaj tag:

  ```bash
  npm version patch
  git push origin main --tags
  ```

- Każdy tag `vX.Y.Z` automatycznie wywoła publikację (jeśli używasz workflowa powyżej).
- W przypadku błędów „unauthorized” upewnij się, że masz poprawne uprawnienia `write:packages`.
