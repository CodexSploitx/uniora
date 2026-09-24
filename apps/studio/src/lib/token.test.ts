import { describe, expect, it } from "vitest";
import { isAllowedHost, tokensMatch } from "./token";

describe("isAllowedHost (DNS-rebinding defense)", () => {
  it.each(["127.0.0.1:4321", "localhost:4321", "[::1]:4321", "LOCALHOST:4321"])("accepts loopback host %s", (host) => {
    expect(isAllowedHost(host, "4321")).toBe(true);
  });

  it.each([
    null,
    "",
    "evil.example.com:4321",
    "127.0.0.1.evil.com:4321",
    "evil.com@127.0.0.1:4321",
    "127.0.0.1:9999",
    "192.168.1.10:4321",
    "0.0.0.0:4321",
    "localhost",
  ])("rejects %s", (host) => {
    expect(isAllowedHost(host, "4321")).toBe(false);
  });

  it("only checks the hostname when the port is unknown", () => {
    expect(isAllowedHost("127.0.0.1:1234", undefined)).toBe(true);
    expect(isAllowedHost("evil.com:1234", undefined)).toBe(false);
  });
});

describe("tokensMatch", () => {
  it("matches identical tokens", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
  });

  it("rejects different tokens, including different lengths and empty input", () => {
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "abc")).toBe(false);
  });
});
