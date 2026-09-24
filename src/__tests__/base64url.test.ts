import { describe, it, expect } from "vitest";
import { toBase64Url } from "../helpers/base64url";

describe("toBase64Url", () => {
  it("replaces the two unsafe std-base64 characters", () => {
    expect(toBase64Url("a+b/c")).toBe("a-b_c");
  });

  it("strips trailing padding", () => {
    expect(toBase64Url("YQ==")).toBe("YQ");
    expect(toBase64Url("YQb=")).toBe("YQb");
  });

  it("leaves an already-safe string unchanged", () => {
    expect(toBase64Url("abc123")).toBe("abc123");
  });
});
