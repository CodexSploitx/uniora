import { constants, createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";

const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export interface TestKey {
  readonly privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
}

/** A key pair for tests: `kind` picks the family. */
export function testKey(kind: "rsa" | "ec256" | "ec384" | "ed", kid = `${kind}-1`): TestKey {
  const pair =
    kind === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : kind === "ed"
        ? generateKeyPairSync("ed25519")
        : generateKeyPairSync("ec", { namedCurve: kind === "ec256" ? "prime256v1" : "secp384r1" });
  return { privateKey: pair.privateKey, publicJwk: { ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig" } };
}

export interface SignOptions {
  readonly alg: string;
  readonly kid?: string | undefined;
  readonly header?: Record<string, unknown>;
}

/** Signs a JWT. `key` is a private key, or a Buffer secret for HS*. Pass `alg: "none"` for an unsigned token. */
export function signJwt(claims: Record<string, unknown>, key: KeyObject | Buffer | undefined, options: SignOptions): string {
  const header = { alg: options.alg, typ: "JWT", ...(options.kid !== undefined ? { kid: options.kid } : {}), ...options.header };
  const input = `${b64(header)}.${b64(claims)}`;
  let signature: Buffer;
  const alg = options.alg;
  if (alg === "none" || key === undefined) signature = Buffer.alloc(0);
  else if (alg.startsWith("HS")) signature = createHmac(`sha${alg.slice(2)}`, key as Buffer).update(input).digest();
  else if (alg === "EdDSA") signature = sign(null, Buffer.from(input), key as KeyObject);
  else if (alg.startsWith("PS")) signature = sign(`sha${alg.slice(2)}`, Buffer.from(input), { key: key as KeyObject, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  else if (alg.startsWith("ES")) signature = sign(`sha${alg.slice(2)}`, Buffer.from(input), { key: key as KeyObject, dsaEncoding: "ieee-p1363" });
  else signature = sign(`sha${alg.slice(2)}`, Buffer.from(input), key as KeyObject);
  return `${input}.${signature.toString("base64url")}`;
}

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
