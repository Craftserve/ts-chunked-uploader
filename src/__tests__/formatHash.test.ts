import { describe, it, expect } from "vitest";
import { formatHashFromApi } from "../helpers/formatHash";

describe("formatHashFromApi", () => {
  it("strips the alg= prefix when present", () => {
    expect(formatHashFromApi("sha-256=abc123", "sha-256")).toBe("abc123");
  });

  it("returns the input unchanged when the prefix is missing", () => {
    expect(formatHashFromApi("abc123", "sha-256")).toBe("abc123");
  });

  it("is case sensitive to the alg prefix", () => {
    // Note: helper uses literal string concat — uppercase 'SHA-256=' is not stripped.
    expect(formatHashFromApi("SHA-256=abc123", "sha-256")).toBe(
      "SHA-256=abc123"
    );
  });

  it("only strips the first occurrence of the prefix", () => {
    expect(formatHashFromApi("sha-256=sha-256=abc", "sha-256")).toBe(
      "sha-256=abc"
    );
  });
});
