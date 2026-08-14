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
  Gdy `overwrite=false` klient dokleja query `?create=1` — **do każdego
  chunka, nie tylko do pierwszego**. URL jest budowany raz, przed pętlą po
  chunkach, więc backend musi traktować `create=1` idempotentnie
  („utwórz, jeśli nie istnieje"). Gdyby wymuszał odrzucenie przy istniejącym
  pliku, każdy upload większy niż jeden chunk padłby na drugim chunku — a
  `4xx` jest klasyfikowane jako błąd nieretryowalny. Zachowanie jest
  przypięte testem `create=1 query parameter › is sent on EVERY chunk`.
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

| Parametr                   | Typ                      | Domyślnie | Opis                                                            |
| -------------------------- | ------------------------ | --------- | --------------------------------------------------------------- |
| `endpoints.upload`         | `string`                 | —         | URL endpointu do wysyłki chunków, np. `/api/upload/{upload_id}` |
| `endpoints.finish`         | `string`                 | —         | URL do weryfikacji i zakończenia uploadu                        |
| `headers`                  | `Record<string, string>` | —         | Dodatkowe nagłówki (np. `Authorization`)                        |
| `alg`                      | `string`                 | `sha-256` | Algorytm haszujący                                              |
| `progressReportIntervalMs` | `number`                 | `1000`    | Minimalny odstęp czasu między raportami postępu (ms)            |
| `progressReportBytes`      | `number`                 | `1000000` | Minimalna liczba bajtów między raportami postępu                |
| `maxChunkRetries`          | `number`                 | `10`      | Liczba prób na chunk (pierwsza próba się liczy; `1` = bez retry)|
| `maxFinishRetries`         | `number`                 | `3`       | Liczba prób wywołania `finish`                                  |
| `chunkRetryDelayMs`        | `number`                 | `10000`   | Odstęp między próbami (anulowalny przez `abort`)                |
| `stallTimeoutMs`           | `number`                 | `60000`   | Budżet **bezruchu** przy wysyłce chunka; `0` wyłącza            |
| `responseTimeoutMs`        | `number`                 | `300000`  | Budżet oczekiwania na odpowiedź serwera; `0` wyłącza            |
| `onChunkRetry`             | `(info) => void`         | —         | Hook przed każdą ponowną próbą (`info.phase`: `chunk`/`finish`) |
| `onFinalize`               | `(sha256) => Promise<void>` | —      | Callback po udanej weryfikacji `finish`                         |

---

## ⏱️ Timeouty

XHR sam z siebie **czeka w nieskończoność**, więc zerwane („half-open")
połączenie potrafiło zawiesić upload na zawsze: `onerror` nie leci, więc
pętla retry jest nieosiągalna, a `await` nigdy się nie kończy. Klient pilnuje
tego dwoma niezależnymi budżetami:

- **`stallTimeoutMs` — budżet bezruchu.** Uzbrajany przed `send()` i
  **przezbrajany przy każdym ruchu bajtów** (`upload.onprogress`). Jest więc
  niezależny od przepustowości: chunk 25 MiB pełznący po łączu 1 Mbit/s
  bez przerwy go resetuje i nigdy nie zostanie ubity — łapane jest wyłącznie
  połączenie, na którym *nic* się nie dzieje.
- **`responseTimeoutMs` — budżet odpowiedzi.** Uzbrajany, gdy ciało żądania
  trafiło już do transportu (`upload.loadend`); od tego momentu nie ma
  więcej zdarzeń postępu, które mogłyby świadczyć o życiu połączenia.
  Domyślne 5 minut jest celowo hojne: `upload.onprogress` raportuje bajty
  oddane do bufora gniazda, a nie potwierdzone przez serwer, więc mały chunk
  potrafi pokazać 100% będąc wciąż w locie. Chodzi o ograniczenie połączenia,
  które **nigdy** nie odpowie — nie o egzekwowanie SLO. Zaciskaj dopiero
  mając telemetrię.

Przekroczenie któregokolwiek budżetu jest raportowane jako `ChunkUploadError`
z `kind: "timeout"` i `retryable: true` — czyli jako coś innego niż
anulowanie przez użytkownika (`kind: "abort"`, `retryable: false`).

---

## 🧯 Błędy

Każda porażka to `ChunkUploadError` z maszynowo czytelnym `kind`, statusem
HTTP i jawnym werdyktem `retryable`:

```ts
import { ChunkUploadError } from "@craftserve/ts-chunked-uploader";

try {
  await uploader.upload(file, 25 * 1024 * 1024);
} catch (err) {
  if (err instanceof ChunkUploadError) {
    console.log(err.kind);      // "http" | "network" | "timeout" | "abort" | "unknown"
    console.log(err.status);    // 507
    console.log(err.retryable); // false
    console.log(err.detail);    // treść błędu z daemona (przycięta)
  }
}
```

Reguła retry: `5xx` tak, `4xx` nie — z czterema świadomymi wyjątkami.
**`507 Insufficient Storage`** i **`501 Not Implemented`** nie są ponawiane
(pełny wolumen sam się nie opróżni; 507 ponawiane 10× co 10 s zamieniało
natychmiastowe „brak miejsca" w 90-sekundową zwiechę zakończoną tym samym
błędem). **`408`** i **`429`** są ponawiane, bo dokładnie o to proszą.

`finish` (GET, idempotentny) jest ponawiany przy błędach przejściowych, ale
**niezgodność sumy kontrolnej lub długości nie jest** — to twarde stwierdzenie
o bajtach na dysku, nie czkawka. `onFinalize` **nie jest ponawiany**: wykonuje
przeniesienie pliku, które nie jest idempotentne, a ponowienie po utraconej
odpowiedzi zgłosiłoby fałszywą porażkę dla pliku, który wylądował poprawnie.

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
