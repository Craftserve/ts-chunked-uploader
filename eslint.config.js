// @ts-check
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");

module.exports = tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      globals: {
        // Browser globals used by the library
        window: "readonly",
        document: "readonly",
        XMLHttpRequest: "readonly",
        FileReader: "readonly",
        File: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        crypto: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        btoa: "readonly",
        atob: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        queueMicrotask: "readonly",
        console: "readonly",
        // Node globals used by config/tooling files
        require: "readonly",
        module: "readonly",
        process: "readonly",
        // Test globals injected by vitest
        globalThis: "readonly",
      },
    },
    rules: {
      // The library uses `as any` deliberately when reading optional /
      // implementation-specific fields off HeadersInit and config objects.
      "@typescript-eslint/no-explicit-any": "off",

      // Unused variables: only warn, ignore _-prefixed args (test stubs use them).
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Allow `let` for variables that look reassignable even when they aren't —
      // upstream style uses `let` for URLs that get rewritten conditionally.
      "prefer-const": "warn",

      // Library uses empty `catch {}` to swallow non-actionable errors
      // (e.g. removeEventListener failing during cleanup). Allow it.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // Test files: relax rules that don't matter in tests.
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-empty-function": "off",
    },
  },
  {
    // This config file is CommonJS (no "type": "module" in package.json),
    // so `require()` is legitimate here.
    files: ["eslint.config.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  }
);
