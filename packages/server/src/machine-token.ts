import { createHash } from "node:crypto";
import { API_SCOPE_LIST } from "@uniora/core";
import type { ApiCredentialStorage, ApiPrincipal, ApiScope } from "@uniora/core";
import { createActorTokenVerifier, resolveActorTokenProviders } from "./actor-token.js";
import type { ActorTokenProvider, ActorTokenVerifier, ActorTokenVerifierOptions, ResolvedProvider } from "./actor-token.js";
import { ServerConfigError } from "./config.js";

/**
 * A machine identity provider: the customer's own OAuth 2.0 / OIDC server, whose `client_credentials` access tokens the server accepts
 * in `Authorization: Bearer`, in place of an UNIORA API key. It is an `ActorTokenProvider` (issuer, audience, pinned algorithms, keys)
 * plus the map from the token's subject to the API client it acts as.
 */
export interface MachineTokenProvider extends ActorTokenProvider {
  /**
   * Which API client each machine is. The key is the token's subject (`sub`, or the claim `subjectClaim` names: Azure AD and Okta put
   * the application id in `azp` or `client_id`), the value an UNIORA API client id. The client's scopes and organization allowlist are
   * the ceiling: a token may narrow them (its `scope` claim) but never widen them. A subject that is not listed is refused.
   */
  readonly clients: Readonly<Record<string, string>>;
}

export interface ResolvedMachineProviders {
  readonly providers: readonly ResolvedProvider[];
  /** provider label -> (subject -> API client id) */
  readonly clients: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

const CONTROL = /[\u0000-\u001f\u007f]/;

export function resolveMachineTokenProviders(input: unknown): ResolvedMachineProviders {
  if (input === undefined) return { providers: [], clients: new Map() };
  if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new ServerConfigError("`machineTokens` must be a list of 1 to 20 providers.");
  const clients = new Map<string, ReadonlyMap<string, string>>();
  const plain = input.map((raw, index): unknown => {
    const where = `machineTokens[${index}]`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ServerConfigError(`${where} must be an object.`);
    const { clients: map, ...rest } = raw as Record<string, unknown>;
    if (typeof map !== "object" || map === null || Array.isArray(map) || Object.keys(map).length === 0 || Object.keys(map).length > 200) {
      throw new ServerConfigError(`${where}.clients is required: the machines you accept, as { "<sub of the token>": "<UNIORA API client id>" } (1 to 200).`);
    }
    const entries = new Map<string, string>();
    for (const [subject, clientId] of Object.entries(map)) {
      if (subject.length < 1 || subject.length > 500 || CONTROL.test(subject)) throw new ServerConfigError(`${where}.clients has a subject that is empty, too long or has control characters.`);
      if (typeof clientId !== "string" || clientId === "" || clientId.length > 200) throw new ServerConfigError(`${where}.clients["${subject.slice(0, 40)}"] must be an API client id.`);
      entries.set(subject, clientId);
    }
    const label = (rest as { provider?: unknown }).provider;
    if (typeof label === "string") clients.set(label, entries);
    return rest;
  });
  return { providers: resolveActorTokenProviders(plain), clients };
}

/** Narrows `granted` to what the token asked for. A token that names no UNIORA scope at all gets none (and so is refused by every route). */
function narrow(granted: readonly ApiScope[], asked: readonly string[] | undefined): ApiScope[] {
  if (asked === undefined) return [...granted];
  const wanted = new Set(asked.filter((scope): scope is ApiScope => (API_SCOPE_LIST as readonly string[]).includes(scope)));
  return granted.filter((scope) => wanted.has(scope));
}

export interface MachineTokenAuthenticator {
  /** The principal a verified machine token stands for, `null` for any reason it does not (one answer, like a bad key), or throws `ActorTokenError("unavailable")` when the keys cannot be fetched. */
  authenticate(token: string): Promise<ApiPrincipal | null>;
}

/** Whether a bearer value is shaped like a JWT (and not like an UNIORA key), so the token path is tried at all. */
export const looksLikeJwt = (value: string): boolean => !value.startsWith("uniora_sk_") && value.split(".").length === 3;

export function createMachineTokenAuthenticator(
  resolved: ResolvedMachineProviders,
  credentials: Pick<ApiCredentialStorage, "apiClients">,
  options: ActorTokenVerifierOptions = {},
): MachineTokenAuthenticator {
  const verifier: ActorTokenVerifier = createActorTokenVerifier(resolved.providers, options);
  const epoch = new Date(0);
  return {
    async authenticate(token) {
      const verified = await verifier.verify(token); // throws ActorTokenError
      const clientId = resolved.clients.get(verified.identity.provider)?.get(verified.identity.subject);
      if (clientId === undefined) return null;
      const client = await credentials.apiClients.findById(clientId);
      if (!client || client.status !== "active") return null;
      // A bucket and a log line per machine identity. The id says it is not an API key.
      const id = `oidc_${createHash("sha256").update(`${verified.identity.provider}\0${verified.identity.subject}`).digest("hex").slice(0, 16)}`;
      return {
        client: { ...client, scopes: narrow(client.scopes, verified.scopes) },
        key: { id, clientId: client.id, hint: "oidc", createdAt: epoch, createdBy: { provider: "uniora-api", subject: "oauth" } },
        credential: "token",
      };
    },
  };
}
