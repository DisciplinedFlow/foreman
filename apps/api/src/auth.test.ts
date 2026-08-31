import { describe, it, expect } from "vitest";
import { signSession, verifySession } from "./auth.js";

describe("session cookie", () => {
  it("round-trips and rejects tampering", () => {
    const c = signSession("11111111-1111-1111-1111-111111111111", "s3cret");
    expect(verifySession(c, "s3cret")).toBe("11111111-1111-1111-1111-111111111111");
    expect(verifySession(c, "wrong")).toBeNull();
    expect(verifySession(c.replace("1", "2"), "s3cret")).toBeNull();
    expect(verifySession(undefined, "s3cret")).toBeNull();
    expect(verifySession("garbage", "s3cret")).toBeNull();
  });
});
