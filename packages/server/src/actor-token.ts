import { constants, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { isReservedIdentityProvider } from "@uniora/core";
import type { AuthorizeSession, Identity } from "@uniora/core";
import { ServerConfigError } from "./config.js";

/**
 * Verified end-user tokens.
 *
 * In asserted mode a delegated call says who it speaks for in a header, and whoever holds the API key can name anybody. Here the
 * end user's own token from YOUR identity provider travels instead (`Uniora-Actor-Token`), and the server verifies it against the
 * provider you configured: issuer, audience and algorithm pinned, the signature checked against the keys you named, `exp` required.
 * The identity comes out of the token, so a leaked API key can no longer speak for an arbitrary user, only for the users who hold a
 * token right now.
 *
 * Nothing in the token chooses how it is verified: the algorithm must be one the provider pinned, the key comes from the provider's
 * own configuration (never from `jku`, `jwk`, `x5u` or any header of the token), and a symmetric algorithm is only ever checked
 * against a configured secret, never against a public key.
 */

export type JwtAlgorithm = "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512" | "EdDSA" | "HS256" | "HS384" | "HS512";

export const JWT_ALGORITHMS: readonly JwtAlgorithm[] = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA", "HS256", "HS384", "HS512"];

export interface JsonWebKeyLike {
  readonly kty?: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly key_ops?: readonly string[];
  readonly [name: string]: unknown;
}

export interface ActorTokenProvider {
  /** The opaque label stored in the identities of this provider's users (the same kind of label as `defaultProvider`). */
  readonly provider: string;
  /** The `iss` of its tokens, compared exactly. */
  readonly issuer: string;
  /** What UNIORA must be named in `aud`: at least one of these must appear in the token. There is no way to switch the check off. */
  readonly audience: string | readonly string[];
  /** The only algorithms accepted for this provider. Pin exactly what the provider signs with: never a mix of symmetric and asymmetric. */
  readonly algorithms: readonly JwtAlgorithm[];
  /** Where the provider publishes its public keys (HTTPS). Fetched by the server, cached, refreshed when a key id is unknown. */
  readonly jwksUri?: string;
  /** Public keys written into the configuration. */
  readonly jwks?: { readonly keys: readonly JsonWebKeyLike[] };
  /** The shared secret of an `HS*` provider (at least 32 bytes). */
  readonly secret?: string | Uint8Array;
  /** The claim that carries the user's id. Default `sub`. */
  readonly subjectClaim?: string;
  /** The longest a token may live (`exp` − `iat`, or `exp` − now without `iat`). Default 86 400 s. */
  readonly maxLifetimeSeconds?: number;
  /** Clock skew allowed on `exp`, `nbf` and `iat`. Default 30 s, at most 120. */
  readonly clockToleranceSeconds?: number;
  /** Maps an `acr` value to an assurance level 0 to 100 (`{ "urn:…:silver": 2 }`), so `session.assuranceLevel` can be read by policies. */
  readonly acrLevels?: Readonly<Record<string, number>>;
  /** How long fetched keys are used before being fetched again. Default 600 s. */
  readonly jwksCacheSeconds?: number;
}

/** What a verified token tells the server about the person and how they authenticated. */
export interface VerifiedActor {
  readonly identity: Identity;
  /** Facts for `session.*` policies, from `auth_time`, `amr` and `acr`. Only what the token states; the rest is unknown. */
  readonly session: AuthorizeSession;
  readonly expiresAt: Date;
  /** The scopes the token states (`scope`, space-separated, or `scp`, a list), or `undefined` when it states none. Used to NARROW a machine token, never to widen it. */
  readonly scopes?: readonly string[];
  /** Every claim of the verified token, as parsed. For the code that decides what a machine token may be (never put it in a response or a log). */
  readonly claims: Readonly<Record<string, unknown>>;
}

/** `invalid`: the token is not acceptable (always the same answer to the caller). `unavailable`: it could not be checked right now. */
export class ActorTokenError extends Error {
  constructor(
    readonly kind: "invalid" | "unavailable",
    /** For the server's log only. */
    readonly reason: string,
  ) {
    super(`actor token ${kind}: ${reason}`);
    this.name = "ActorTokenError";
  }
}

export interface ActorTokenVerifier {
  verify(token: string): Promise<VerifiedActor>;
}

export interface ActorTokenVerifierOptions {
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  /** Called when something about the key source needs the operator's eyes (never with a token). */
  readonly onWarning?: (message: string, detail?: Record<string, unknown>) => void;
}

const MAX_TOKEN_LENGTH = 8192;
const MAX_JWKS_BYTES = 256 * 1024;
const MAX_JWKS_KEYS = 50;
const FETCH_TIMEOUT_MS = 3_000;
/** Unknown key ids refresh the keys at most this often, so a stream of made-up `kid`s cannot make the server hammer the provider. */
const MIN_REFRESH_INTERVAL_MS = 30_000;
/** After a failed fetch, wait this long before trying again. */
const FAILURE_BACKOFF_MS = 5_000;
const STALE_KEYS_MS = 3_600_000;
const MIN_RSA_BITS = 2048;
const MIN_SECRET_BYTES = 32;
const PROVIDER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const METHOD = /^[A-Za-z0-9_.:-]{1,64}$/;

const FAMILY = (algorithm: JwtAlgorithm): "rsa" | "ec" | "ed" | "hmac" =>
  algorithm.startsWith("RS") || algorithm.startsWith("PS") ? "rsa" : algorithm.startsWith("ES") ? "ec" : algorithm === "EdDSA" ? "ed" : "hmac";
const HASH: Readonly<Record<string, string>> = { "256": "sha256", "384": "sha384", "512": "sha512" };
const CURVE: Readonly<Record<string, { name: string; signatureBytes: number }>> = {
  ES256: { name: "prime256v1", signatureBytes: 64 },
  ES384: { name: "secp384r1", signatureBytes: 96 },
  ES512: { name: "secp521r1", signatureBytes: 132 },
};
const hashOf = (algorithm: JwtAlgorithm): string => HASH[algorithm.slice(-3)]!;

// ---------------------------------------------------------------------------------------------------------------------
// Configuration

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks the providers at start-up and returns them in the shape the verifier uses. Anything doubtful is a refusal to start. */
export function resolveActorTokenProviders(input: unknown): readonly ResolvedProvider[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new ServerConfigError("`actorTokens` must be a list of 1 to 20 providers.");
  const labels = new Set<string>();
  const issuers = new Set<string>();
  return input.map((raw, index): ResolvedProvider => {
    const where = `actorTokens[${index}]`;
    if (!isRecord(raw)) throw new ServerConfigError(`${where} must be an object.`);
    const known = new Set(["provider", "issuer", "audience", "algorithms", "jwksUri", "jwks", "secret", "subjectClaim", "maxLifetimeSeconds", "clockToleranceSeconds", "acrLevels", "jwksCacheSeconds"]);
    for (const key of Object.keys(raw)) if (!known.has(key)) throw new ServerConfigError(`${where}: unknown option "${key}".`);

    const provider = raw.provider;
    if (typeof provider !== "string" || !PROVIDER_LABEL.test(provider)) throw new ServerConfigError(`${where}.provider must be 1 to 64 characters from A-Z a-z 0-9 _ . : -.`);
    if (isReservedIdentityProvider(provider)) throw new ServerConfigError(`${where}.provider cannot be "${provider}": that label is reserved for UNIORA's own principals.`);
    if (labels.has(provider)) throw new ServerConfigError(`${where}.provider "${provider}" is listed twice.`);
    labels.add(provider);

    const issuer = raw.issuer;
    if (typeof issuer !== "string" || issuer === "" || issuer.length > 500 || CONTROL.test(issuer)) throw new ServerConfigError(`${where}.issuer must be the exact \`iss\` of the provider's tokens.`);
    if (issuers.has(issuer)) throw new ServerConfigError(`${where}.issuer "${issuer}" is listed twice: a token must belong to exactly one provider.`);
    issuers.add(issuer);

    const audiences = typeof raw.audience === "string" ? [raw.audience] : raw.audience;
    if (!Array.isArray(audiences) || audiences.length === 0 || audiences.length > 10 || audiences.some((value) => typeof value !== "string" || value === "" || value.length > 500)) {
      throw new ServerConfigError(`${where}.audience is required: the value(s) your tokens carry in \`aud\` for UNIORA. A token for another service must not be accepted.`);
    }

    const algorithms = raw.algorithms;
    if (!Array.isArray(algorithms) || algorithms.length === 0 || algorithms.length > 4 || algorithms.some((value) => !JWT_ALGORITHMS.includes(value as JwtAlgorithm))) {
      throw new ServerConfigError(`${where}.algorithms is required: pin what the provider signs with (${JWT_ALGORITHMS.join(", ")}).`);
    }
    const symmetric = (algorithms as JwtAlgorithm[]).map((algorithm) => FAMILY(algorithm) === "hmac");
    if (symmetric.some(Boolean) && !symmetric.every(Boolean)) throw new ServerConfigError(`${where}.algorithms cannot mix symmetric (HS*) and asymmetric algorithms.`);
    const hmac = symmetric[0] === true;

    const sources = [raw.jwksUri, raw.jwks, raw.secret].filter((value) => value !== undefined).length;
    if (sources !== 1) throw new ServerConfigError(`${where} needs exactly one of \`jwksUri\`, \`jwks\` or \`secret\`.`);
    let secret: Buffer | undefined;
    let jwksUri: URL | undefined;
    let staticKeys: ResolvedKey[] | undefined;
    if (hmac) {
      if (raw.secret === undefined) throw new ServerConfigError(`${where}: an HS* algorithm needs \`secret\`.`);
      secret = typeof raw.secret === "string" ? Buffer.from(raw.secret, "utf8") : Buffer.from(raw.secret as Uint8Array);
      if (secret.length < MIN_SECRET_BYTES) throw new ServerConfigError(`${where}.secret must be at least ${MIN_SECRET_BYTES} bytes.`);
    } else {
      if (raw.secret !== undefined) throw new ServerConfigError(`${where}: \`secret\` is only for HS* algorithms. An asymmetric algorithm is checked against public keys, never a secret.`);
      if (raw.jwksUri !== undefined) {
        try {
          jwksUri = new URL(String(raw.jwksUri));
        } catch {
          throw new ServerConfigError(`${where}.jwksUri must be a URL.`);
        }
        const loopback = /^(localhost|127(?:\.\d+){3}|\[::1\])$/.test(jwksUri.hostname);
        if (jwksUri.protocol !== "https:" && !(jwksUri.protocol === "http:" && loopback)) throw new ServerConfigError(`${where}.jwksUri must be https: (plain http only to this machine).`);
        if (jwksUri.username !== "" || jwksUri.password !== "" || jwksUri.hash !== "") throw new ServerConfigError(`${where}.jwksUri must not carry credentials or a fragment.`);
      } else {
        const keys = isRecord(raw.jwks) && Array.isArray(raw.jwks.keys) ? (raw.jwks.keys as unknown[]) : undefined;
        if (!keys || keys.length === 0 || keys.length > MAX_JWKS_KEYS) throw new ServerConfigError(`${where}.jwks must be { keys: [...] } with 1 to ${MAX_JWKS_KEYS} keys.`);
        staticKeys = keys.map((jwk, keyIndex) => {
          const imported = importKey(jwk);
          if (!imported) throw new ServerConfigError(`${where}.jwks.keys[${keyIndex}] is not a usable public key (RSA of at least ${MIN_RSA_BITS} bits, EC P-256/384/521 or Ed25519; never a private key).`);
          return imported;
        });
      }
    }

    const subjectClaim = raw.subjectClaim ?? "sub";
    if (typeof subjectClaim !== "string" || subjectClaim === "" || subjectClaim.length > 64 || ["__proto__", "constructor", "prototype"].includes(subjectClaim)) throw new ServerConfigError(`${where}.subjectClaim must be a claim name.`);
    const number = (name: string, value: unknown, fallback: number, min: number, max: number): number => {
      if (value === undefined) return fallback;
      if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new ServerConfigError(`${where}.${name} must be an integer from ${min} to ${max}.`);
      return value;
    };
    let acrLevels: Map<string, number> | undefined;
    if (raw.acrLevels !== undefined) {
      if (!isRecord(raw.acrLevels) || Object.keys(raw.acrLevels).length > 50) throw new ServerConfigError(`${where}.acrLevels must be an object of at most 50 entries.`);
      acrLevels = new Map();
      for (const [acr, level] of Object.entries(raw.acrLevels)) {
        if (typeof level !== "number" || !Number.isInteger(level) || level < 0 || level > 100) throw new ServerConfigError(`${where}.acrLevels["${acr}"] must be an integer from 0 to 100.`);
        acrLevels.set(acr, level);
      }
    }
    return {
      provider,
      issuer,
      audiences: audiences as string[],
      algorithms: algorithms as JwtAlgorithm[],
      family: hmac ? "hmac" : "asymmetric",
      secret,
      jwksUri,
      staticKeys,
      subjectClaim,
      maxLifetimeSeconds: number("maxLifetimeSeconds", raw.maxLifetimeSeconds, 86_400, 1, 30 * 86_400),
      clockToleranceSeconds: number("clockToleranceSeconds", raw.clockToleranceSeconds, 30, 0, 120),
      jwksCacheSeconds: number("jwksCacheSeconds", raw.jwksCacheSeconds, 600, 30, 86_400),
      acrLevels,
    };
  });
}

export interface ResolvedKey {
  readonly key: KeyObject;
  readonly kid: string | undefined;
  readonly use: string | undefined;
  readonly alg: string | undefined;
  readonly keyOps: readonly string[] | undefined;
  readonly type: "rsa" | "ec" | "ed";
  readonly curve: string | undefined;
}

export interface ResolvedProvider {
  readonly provider: string;
  readonly issuer: string;
  readonly audiences: readonly string[];
  readonly algorithms: readonly JwtAlgorithm[];
  readonly family: "hmac" | "asymmetric";
  readonly secret: Buffer | undefined;
  readonly jwksUri: URL | undefined;
  readonly staticKeys: readonly ResolvedKey[] | undefined;
  readonly subjectClaim: string;
  readonly maxLifetimeSeconds: number;
  readonly clockToleranceSeconds: number;
  readonly jwksCacheSeconds: number;
  readonly acrLevels: ReadonlyMap<string, number> | undefined;
}

/** A public key from a JWK, or `undefined` when it is anything else: a private key, a small RSA key, an unknown type or curve. */
function importKey(jwk: unknown): ResolvedKey | undefined {
  if (!isRecord(jwk) || typeof jwk.kty !== "string") return undefined;
  // A private JWK in a key set is a leak waiting to happen: refuse it instead of quietly using its public half.
  for (const secretField of ["d", "p", "q", "dp", "dq", "qi", "k"]) if (secretField in jwk) return undefined;
  try {
    const key = createPublicKey({ key: jwk as never, format: "jwk" });
    const details = key.asymmetricKeyDetails;
    const type = key.asymmetricKeyType;
    const base = {
      key,
      kid: typeof jwk.kid === "string" ? jwk.kid : undefined,
      use: typeof jwk.use === "string" ? jwk.use : undefined,
      alg: typeof jwk.alg === "string" ? jwk.alg : undefined,
      keyOps: Array.isArray(jwk.key_ops) ? (jwk.key_ops as string[]) : undefined,
    };
    if (type === "rsa" || type === "rsa-pss") return details?.modulusLength !== undefined && details.modulusLength >= MIN_RSA_BITS ? { ...base, type: "rsa", curve: undefined } : undefined;
    if (type === "ec") return details?.namedCurve && ["prime256v1", "secp384r1", "secp521r1"].includes(details.namedCurve) ? { ...base, type: "ec", curve: details.namedCurve } : undefined;
    if (type === "ed25519") return { ...base, type: "ed", curve: undefined };
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Keys of a provider: configured, or fetched and cached

class KeySource {
  private keys: readonly ResolvedKey[] = [];
  private fetchedAt = 0;
  private refreshedAt = 0;
  private failedAt = 0;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly provider: ResolvedProvider,
    private readonly now: () => number,
    private readonly fetchImpl: typeof fetch,
    private readonly warn: (message: string, detail?: Record<string, unknown>) => void,
  ) {
    if (provider.staticKeys) this.keys = provider.staticKeys;
  }

  /** The keys that may verify a token with this `kid`, refreshing from the provider when the answer may have changed. */
  async candidates(algorithm: JwtAlgorithm, kid: string | undefined): Promise<ResolvedKey[]> {
    if (this.provider.staticKeys) return select(this.keys, algorithm, kid);
    const age = this.now() - this.fetchedAt;
    const fresh = this.fetchedAt > 0 && age < this.provider.jwksCacheSeconds * 1000;
    if (fresh) {
      const found = select(this.keys, algorithm, kid);
      if (found.length > 0) return found;
      // The provider may have rotated its keys: look again, but never more often than the minimum interval.
      if (this.now() - this.refreshedAt < MIN_REFRESH_INTERVAL_MS) return [];
    }
    await this.refresh();
    return select(this.keys, algorithm, kid);
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    // A provider that just failed is not asked again for a few seconds; what we hold is used while it is recent enough.
    if (this.failedAt > 0 && this.now() - this.failedAt < FAILURE_BACKOFF_MS) return this.useStaleOrFail("backing off after a failed fetch");
    this.inflight = this.load().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private useStaleOrFail(reason: string): void {
    if (this.fetchedAt > 0 && this.now() - this.fetchedAt < STALE_KEYS_MS) return;
    throw new ActorTokenError("unavailable", reason);
  }

  private async load(): Promise<void> {
    const uri = this.provider.jwksUri!;
    this.refreshedAt = this.now();
    try {
      const response = await this.fetchImpl(uri, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.status !== 200) throw new Error(`status ${response.status}`);
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_JWKS_BYTES) throw new Error("the key set is too large");
      const text = await readCapped(response, MAX_JWKS_BYTES);
      const parsed: unknown = JSON.parse(text);
      const list = isRecord(parsed) && Array.isArray(parsed.keys) ? (parsed.keys as unknown[]).slice(0, MAX_JWKS_KEYS) : undefined;
      if (!list) throw new Error("not a key set");
      const keys = list.map(importKey).filter((key): key is ResolvedKey => key !== undefined);
      if (keys.length === 0) throw new Error("no usable key in the key set");
      this.keys = keys;
      this.fetchedAt = this.now();
      this.failedAt = 0;
    } catch (error) {
      this.failedAt = this.now();
      this.warn("could not fetch the keys of an actor-token provider", { provider: this.provider.provider, host: uri.host, error: error instanceof Error ? error.message : String(error) });
      this.useStaleOrFail("the provider's keys could not be fetched");
    }
  }
}

async function readCapped(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("the key set is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function select(keys: readonly ResolvedKey[], algorithm: JwtAlgorithm, kid: string | undefined): ResolvedKey[] {
  const family = FAMILY(algorithm);
  const matches = keys.filter((entry) => {
    if (entry.type !== family) return false;
    if (family === "ec" && entry.curve !== CURVE[algorithm]!.name) return false;
    if (entry.use !== undefined && entry.use !== "sig") return false;
    if (entry.keyOps !== undefined && !entry.keyOps.includes("verify")) return false;
    if (entry.alg !== undefined && entry.alg !== algorithm) return false;
    return true;
  });
  if (kid !== undefined) return matches.filter((entry) => entry.kid === kid);
  // A token with no `kid` can only mean "the" key when there is exactly one it could be.
  return matches.length === 1 ? matches : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Verification

function decodeSegment(segment: string): Record<string, unknown> {
  if (!BASE64URL.test(segment)) throw new ActorTokenError("invalid", "malformed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new ActorTokenError("invalid", "malformed");
  }
  if (!isRecord(parsed)) throw new ActorTokenError("invalid", "malformed");
  return parsed;
}

function signatureIsValid(algorithm: JwtAlgorithm, data: Buffer, signature: Buffer, key: KeyObject | Buffer): boolean {
  try {
    const family = FAMILY(algorithm);
    if (family === "hmac") {
      const expected = createHmac(hashOf(algorithm), key as Buffer).update(data).digest();
      return expected.length === signature.length && timingSafeEqual(expected, signature);
    }
    const publicKey = key as KeyObject;
    if (family === "rsa") {
      if (algorithm.startsWith("PS")) return verify(hashOf(algorithm), data, { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, signature);
      return verify(hashOf(algorithm), data, { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, signature);
    }
    if (family === "ec") {
      if (signature.length !== CURVE[algorithm]!.signatureBytes) return false; // JWS uses raw r||s, never DER
      return verify(hashOf(algorithm), data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
    }
    return verify(null, data, publicKey, signature);
  } catch {
    return false;
  }
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function createActorTokenVerifier(providers: readonly ResolvedProvider[], options: ActorTokenVerifierOptions = {}): ActorTokenVerifier {
  const nowMs = () => (options.now ?? (() => new Date()))().getTime();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const warn = options.onWarning ?? (() => undefined);
  const byIssuer = new Map(providers.map((provider) => [provider.issuer, provider]));
  const sources = new Map(providers.map((provider) => [provider.provider, new KeySource(provider, nowMs, fetchImpl, warn)]));

  return {
    async verify(token) {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new ActorTokenError("invalid", "malformed");
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] === "" || parts[1] === "" || parts[2] === "") throw new ActorTokenError("invalid", "malformed");
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const header = decodeSegment(headerPart);
      const claims = decodeSegment(payloadPart);

      const algorithm = header.alg;
      if (typeof algorithm !== "string" || !JWT_ALGORITHMS.includes(algorithm as JwtAlgorithm)) throw new ActorTokenError("invalid", "alg_not_supported");
      // Extensions we do not implement must not be silently ignored (RFC 7515 §4.1.11).
      if ("crit" in header) throw new ActorTokenError("invalid", "crit");
      if (header.typ !== undefined && (typeof header.typ !== "string" || !["jwt", "at+jwt"].includes(header.typ.toLowerCase()))) throw new ActorTokenError("invalid", "typ");
      if (header.kid !== undefined && (typeof header.kid !== "string" || header.kid.length > 500)) throw new ActorTokenError("invalid", "kid");

      const provider = typeof claims.iss === "string" ? byIssuer.get(claims.iss) : undefined;
      if (!provider) throw new ActorTokenError("invalid", "unknown_issuer");
      if (!provider.algorithms.includes(algorithm as JwtAlgorithm)) throw new ActorTokenError("invalid", "alg_not_allowed");

      const data = Buffer.from(`${headerPart}.${payloadPart}`, "ascii");
      if (!BASE64URL.test(signaturePart)) throw new ActorTokenError("invalid", "malformed");
      const signature = Buffer.from(signaturePart, "base64url");

      let verified = false;
      if (provider.family === "hmac") {
        verified = signatureIsValid(algorithm as JwtAlgorithm, data, signature, provider.secret!);
      } else {
        const candidates = await sources.get(provider.provider)!.candidates(algorithm as JwtAlgorithm, header.kid as string | undefined);
        if (candidates.length === 0) throw new ActorTokenError("invalid", "key_not_found");
        verified = candidates.some((candidate) => signatureIsValid(algorithm as JwtAlgorithm, data, signature, candidate.key));
      }
      if (!verified) throw new ActorTokenError("invalid", "bad_signature");

      // The signature holds; now what the token says.
      const seconds = Math.floor(nowMs() / 1000);
      const tolerance = provider.clockToleranceSeconds;
      const { exp, nbf, iat } = claims;
      if (!finite(exp)) throw new ActorTokenError("invalid", "exp_missing");
      if (seconds - tolerance >= exp) throw new ActorTokenError("invalid", "expired");
      if (nbf !== undefined && (!finite(nbf) || seconds + tolerance < nbf)) throw new ActorTokenError("invalid", "not_yet_valid");
      if (iat !== undefined && (!finite(iat) || iat > seconds + tolerance)) throw new ActorTokenError("invalid", "iat");
      if (exp - (finite(iat) ? iat : seconds) > provider.maxLifetimeSeconds + tolerance) throw new ActorTokenError("invalid", "lifetime");

      const aud = claims.aud;
      const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) && aud.every((value) => typeof value === "string") ? (aud as string[]) : [];
      if (!audiences.some((value) => provider.audiences.includes(value))) throw new ActorTokenError("invalid", "audience");

      const subject = claims[provider.subjectClaim];
      if (typeof subject !== "string" || subject.length < 1 || subject.length > 500 || CONTROL.test(subject)) throw new ActorTokenError("invalid", "subject");

      const scopes = scopesOf(claims);
      return { identity: { provider: provider.provider, subject }, session: sessionOf(provider, claims, seconds, tolerance), expiresAt: new Date(exp * 1000), claims, ...(scopes ? { scopes } : {}) };
    },
  };
}

const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/;

/** `scope` (RFC 6749: space-separated) or `scp` (a list): what the token says it may do. A malformed claim refuses the token. */
function scopesOf(claims: Record<string, unknown>): string[] | undefined {
  // An explicit null is a malformed claim, not an absent one.
  const raw = claims.scope !== undefined ? claims.scope : claims.scp;
  if (raw === undefined) return undefined;
  const items = typeof raw === "string" ? raw.split(" ").filter((item) => item !== "") : raw;
  if (!Array.isArray(items) || items.length > 50 || items.some((item) => typeof item !== "string" || !SCOPE_TOKEN.test(item))) throw new ActorTokenError("invalid", "scope");
  return [...new Set(items as string[])];
}

/** What the token says about how the person authenticated. Only stated facts; an absent claim stays unknown. */
function sessionOf(provider: ResolvedProvider, claims: Record<string, unknown>, seconds: number, tolerance: number): AuthorizeSession {
  const session: { authenticatedAt?: Date; mfa?: boolean; methods?: string[]; assuranceLevel?: number } = {};
  const authTime = claims.auth_time;
  if (finite(authTime) && authTime > 0 && authTime <= seconds + tolerance) session.authenticatedAt = new Date(authTime * 1000);
  const amr = claims.amr;
  if (Array.isArray(amr) && amr.length <= 16 && amr.every((value) => typeof value === "string" && METHOD.test(value))) {
    session.methods = [...new Set(amr as string[])];
    // RFC 8176 names one value for multiple factors: `mfa`. Anything else is a single method and says nothing about a second factor.
    session.mfa = session.methods.includes("mfa");
  }
  const acr = claims.acr;
  if (typeof acr === "string" && provider.acrLevels?.has(acr)) session.assuranceLevel = provider.acrLevels.get(acr)!;
  return session;
}
