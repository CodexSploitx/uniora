import { describe, expect, it } from "vitest";
import {
  API_KEY_MAX_LENGTH,
  API_KEY_PREFIX,
  bearerToken,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  randomBase62,
  verifyApiKeySecret,
} from "./key.js";

describe("generateApiKey", () => {
  it("has the documented shape and parses back to its id and secret", () => {
    const key = generateApiKey();
    expect(key.token).toHaveLength(API_KEY_MAX_LENGTH);
    expect(key.token).toMatch(/^uniora_sk_[0-9A-Za-z]{16}_[0-9A-Za-z]{43}_[0-9A-Za-z]{6}$/);
    expect(key.token.startsWith(API_KEY_PREFIX)).toBe(true);
    const parsed = parseApiKey(key.token);
    expect(parsed?.id).toBe(key.id);
    expect(key.hint).toBe(parsed!.secret.slice(-4));
    expect(key.secretHash).toBe(hashApiKeySecret(parsed!.secret));
    expect(key.secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats an id or a secret", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { id, secretHash } = generateApiKey();
      expect(seen.has(id)).toBe(false);
      expect(seen.has(secretHash)).toBe(false);
      seen.add(id).add(secretHash);
    }
  });

  it("the token itself is not contained in the stored digest or the hint", () => {
    const key = generateApiKey();
    expect(key.secretHash).not.toContain(parseApiKey(key.token)!.secret);
    expect(key.token).not.toContain(key.secretHash);
  });
});

describe("parseApiKey", () => {
  it("rejects a change of any single character, anywhere in the key", () => {
    const { token } = generateApiKey();
    for (let position = 0; position < token.length; position++) {
      for (const replacement of ["a", "Z", "0", "_", "-", " "]) {
        if (token[position] === replacement) continue;
        const mutated = token.slice(0, position) + replacement + token.slice(position + 1);
        expect(parseApiKey(mutated), `position ${position} -> ${JSON.stringify(replacement)}`).toBeNull();
      }
    }
  });

  it("rejects the wrong length, other types and look-alikes", () => {
    const { token } = generateApiKey();
    for (const value of [undefined, null, 42, {}, [], "", " ", token.slice(1), token + "x", ` ${token}`, `${token}\n`, token.toLowerCase(), token.replace("uniora_sk_", "uniora_pk_")]) {
      expect(parseApiKey(value)).toBeNull();
    }
    expect(parseApiKey("x".repeat(10_000))).toBeNull();
  });
});

describe("verifyApiKeySecret", () => {
  it("accepts the right secret and nothing else, including a malformed digest", () => {
    const { token, secretHash } = generateApiKey();
    const { secret } = parseApiKey(token)!;
    expect(verifyApiKeySecret(secret, secretHash)).toBe(true);
    expect(verifyApiKeySecret(secret + "x", secretHash)).toBe(false);
    expect(verifyApiKeySecret("", secretHash)).toBe(false);
    expect(verifyApiKeySecret(secret, "")).toBe(false);
    expect(verifyApiKeySecret(secret, "zz".repeat(32))).toBe(false);
    expect(verifyApiKeySecret(secret, secretHash.slice(0, 62))).toBe(false);
  });
});

describe("bearerToken", () => {
  it("extracts exactly one token from a Bearer header", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    for (const header of [undefined, null, 1, "", "Bearer", "Bearer ", "Bearer a b", "Basic abc", "Bearer  abc", "abc", " Bearer abc", ["Bearer abc"]]) {
      expect(bearerToken(header), String(header)).toBeUndefined();
    }
  });
});

describe("randomBase62", () => {
  it("returns only base62 characters, of the right length, with every character reachable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const char of randomBase62(50)) seen.add(char);
    expect(randomBase62(7)).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(randomBase62(0)).toBe("");
    expect(seen.size).toBe(62);
  });
});
