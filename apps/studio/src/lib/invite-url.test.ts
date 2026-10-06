import { describe, expect, it } from "vitest";
import { inviteUrlFactory } from "./invite-url";

describe("inviteUrlFactory", () => {
  it("fills the token into the path or the fragment", () => {
    expect(inviteUrlFactory("https://app.example.com/invite/{token}")?.("abc")).toBe("https://app.example.com/invite/abc");
    expect(inviteUrlFactory("https://app.example.com/accept#{token}")?.("abc")).toBe("https://app.example.com/accept#abc");
  });

  it("rejects a missing, repeated or query-string placeholder", () => {
    expect(inviteUrlFactory(undefined)).toBeNull();
    expect(inviteUrlFactory("")).toBeNull();
    expect(inviteUrlFactory("https://app.example.com/invite")).toBeNull();
    expect(inviteUrlFactory("https://app.example.com/{token}/{token}")).toBeNull();
    expect(inviteUrlFactory("https://app.example.com/invite?t={token}")).toBeNull();
  });

  it("rejects unsafe schemes and embedded credentials", () => {
    expect(inviteUrlFactory("javascript:alert('{token}')")).toBeNull();
    expect(inviteUrlFactory("https://user:pass@app.example.com/{token}")).toBeNull();
    expect(inviteUrlFactory("not a url {token}")).toBeNull();
  });
});
