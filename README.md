# @craftserve/ts-chunked-uploader

Biblioteka frontendowa TypeScript do **wysyłania dużych plików w częściach (chunkach)** z raportowaniem postępu, obsługą anulowania oraz weryfikacją integralności danych po stronie serwera.

---

## ✨ Funkcje

-   Upload plików w częściach (`chunked upload`)
-   Raportowanie postępu (`onprogress`)
-   Obsługa anulowania (`abort`)
-   Automatyczne obliczanie i weryfikacja sumy kontrolnej (`SHA-256` domyślnie)
-   Obsługa throttlingu eventów postępu (limit czasowy i objętościowy)
-   Integracja z backendowymi endpointami `upload` i `finish`

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

-   Aby opublikować nową wersję, zwiększ wersję w `package.json` i dodaj tag:

    ```bash
    npm version patch
    git push origin main --tags
    ```

-   Każdy tag `vX.Y.Z` automatycznie wywoła publikację (jeśli używasz workflowa powyżej).
-   W przypadku błędów „unauthorized” upewnij się, że masz poprawne uprawnienia `write:packages`.
