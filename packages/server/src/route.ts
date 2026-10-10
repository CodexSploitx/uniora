import type { UnioraStorage, AccessAdminService, ApiPrincipal, ApiScope, AuthorizationEngine, Identity, InvitationService, PolicyService, TeamService } from "@uniora/core";
import type { ResolvedConfig } from "./config.js";
import type { Infer, Issue, ObjectSchema, Schema } from "./schema.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * What a delegated handler works with: the services, built for THIS request over a storage that refuses unauthorized changes
 * of power and stamps every audit entry with `via` (the API client, the key and the request id). They act as `actor`.
 */
export interface ApplicationContext {
  /** The API client as an actor in the audit log: `{ provider: "uniora-api", subject: <clientId> }`. */
  readonly principal: Identity;
  /** The operator's storage under the access guard and the audit context. Founding flows (`createOrganizationWithOwner`) are the only writes that may use it directly. */
  readonly storage: UnioraStorage;
  /** `undefined` until the operator configures `invitations`. */
  readonly invitations: InvitationService | undefined;
}

export interface DelegatedContext extends ApplicationContext {
  readonly actor: Identity;
  readonly access: AccessAdminService;
  readonly teams: TeamService;
  readonly policies: PolicyService;
}

/** What a handler may use. Note what is NOT here: no credential storage, no way to create or change an API client or key. */
export interface RouteContext {
  readonly requestId: string;
  readonly principal: ApiPrincipal;
  readonly config: ResolvedConfig;
  readonly engine: AuthorizationEngine;
  readonly now: () => Date;
  /** `{ provider?, subject }` as a caller sent it, completed with the configured default provider. Throws 400 when it cannot. */
  resolveIdentity(input: { provider?: string | undefined; subject: string }, path: string): Identity;
  /** Services for an application call (no end user): the API client acts as itself. */
  application(): ApplicationContext;
  /** Only on a `delegated` route: the end user the call speaks for and the services that act as them. Anywhere else it is a bug (500). */
  delegated(): DelegatedContext;
  /** The `Idempotency-Key` header (1 to 128 letters, digits and `._:-`), or `undefined`. A malformed one is a 400 before the handler runs. */
  readonly idempotencyKey: string | undefined;
  /** The `If-Match` header as a version number, or `undefined` when it was not sent. A malformed one is a 400 before the handler runs. */
  readonly ifMatch: number | undefined;
  /** Adds a response header (`ETag`, `Location`). Nothing else may be set. */
  setHeader(name: "ETag" | "Location", value: string): void;
}

type InputOf<S> = [S] extends [undefined] ? undefined : Infer<S>;
/** The value a handler must return for the response schema `R`. The conditional defers evaluation until `R` is known (without it, inference walks the whole `Schema` union and gives up). */
type Out<R> = R extends Schema ? Infer<R> : never;

export interface RouteInput<Pa, Q, B> {
  readonly params: InputOf<Pa>;
  readonly query: InputOf<Q>;
  readonly body: InputOf<B>;
}

export interface RouteSpec<Pa extends ObjectSchema | undefined = undefined, Q extends ObjectSchema | undefined = undefined, B extends ObjectSchema | undefined = undefined, R extends Schema = Schema> {
  /** Stable identifier (`checks.check`): used in logs, the OpenAPI `operationId` and the documentation. */
  readonly id: string;
  readonly method: HttpMethod;
  /** `/v1/organizations/:organizationId/members`. A segment starting with `:` is a parameter; anything else is literal. */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  /** The one scope a client needs. A route with no scope cannot be declared. */
  readonly scope: ApiScope;
  readonly params?: Pa;
  readonly query?: Q;
  readonly body?: B;
  readonly response: R;
  /** HTTP status of a success (default 200). */
  readonly status?: 200 | 201 | 204;
  /** Which organization the call is about, so the key's allowlist can be enforced before the handler runs. `undefined` = not organization-scoped. */
  readonly organization?: (input: NoInfer<RouteInput<Pa, Q, B>>) => string | undefined;
  /** Rules a schema cannot say ("at least one of permission/feature"). */
  readonly refine?: (input: NoInfer<RouteInput<Pa, Q, B>>) => Issue[];
  /** Changes data: refused with 503 `read_only` when the server is in read-only mode. */
  readonly write?: boolean;
  /**
   * A call on behalf of an end user, who travels in the `Uniora-Actor-*` headers (never in the body). It needs the `actor:assert`
   * scope on top of the route's own, and the services then apply their rules to that user: a key cannot do more than the user it
   * speaks for.
   */
  readonly delegated?: boolean;
  /**
   * The call is about something the route cannot name an organization for (the token of an invitation, the creation of a new
   * organization), so a client restricted to some organizations cannot be allowed to make it: only a client with `"*"` can.
   */
  readonly allOrganizations?: boolean;
  /** Every error `code` this route can answer besides the ones every route can (`unauthenticated`, `forbidden`, `rate_limited`, ...). */
  readonly errors: readonly string[];
  readonly handler: (ctx: RouteContext, input: NoInfer<RouteInput<Pa, Q, B>>) => Promise<Out<NoInfer<R>>>;
}

/** A route with its types erased, as the pipeline runs it. */
export interface Route {
  readonly id: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly scope: ApiScope;
  readonly params: ObjectSchema | undefined;
  readonly query: ObjectSchema | undefined;
  readonly body: ObjectSchema | undefined;
  readonly response: Schema;
  readonly status: 200 | 201 | 204;
  readonly write: boolean;
  readonly delegated: boolean;
  readonly allOrganizations: boolean;
  readonly errors: readonly string[];
  readonly organization: ((input: never) => string | undefined) | undefined;
  readonly refine: ((input: never) => Issue[]) | undefined;
  readonly handler: (ctx: RouteContext, input: never) => Promise<unknown>;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
}

const SEGMENT_PARAM = /^:([A-Za-z][A-Za-z0-9]*)$/;
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A route is a typed definition; this checks it for the mistakes a type cannot catch and erases the types. */
export function defineRoute<Pa extends ObjectSchema | undefined = undefined, Q extends ObjectSchema | undefined = undefined, B extends ObjectSchema | undefined = undefined, R extends Schema = Schema>(
  spec: RouteSpec<Pa, Q, B, R>,
): Route {
  if (!spec.path.startsWith("/v1/")) throw new Error(`Route ${spec.id}: paths live under /v1/.`);
  if (!spec.scope) throw new Error(`Route ${spec.id}: every route names exactly one scope.`);
  if (spec.method === "GET" && spec.body) throw new Error(`Route ${spec.id}: a GET has no body.`);
  const names: string[] = [];
  const pattern = spec.path
    .split("/")
    .map((segment) => {
      const match = SEGMENT_PARAM.exec(segment);
      if (!match) return escapeRegex(segment);
      names.push(match[1]!);
      return "([^/]+)";
    })
    .join("/");
  const declared = Object.keys(spec.params?.shape ?? {}).sort();
  if (JSON.stringify(declared) !== JSON.stringify([...names].sort())) {
    throw new Error(`Route ${spec.id}: the path parameters (${names.join(", ")}) and the params schema (${declared.join(", ")}) differ.`);
  }
  return {
    id: spec.id,
    method: spec.method,
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    scope: spec.scope,
    params: spec.params,
    query: spec.query,
    body: spec.body,
    response: spec.response,
    status: spec.status ?? 200,
    write: spec.write ?? spec.method !== "GET",
    delegated: spec.delegated ?? false,
    allOrganizations: spec.allOrganizations ?? false,
    errors: spec.errors,
    organization: spec.organization as Route["organization"],
    refine: spec.refine as Route["refine"],
    handler: spec.handler as Route["handler"],
    pattern: new RegExp(`^${pattern}$`),
    paramNames: names,
  };
}

export type RouteMatch =
  | { readonly kind: "match"; readonly route: Route; readonly rawParams: Record<string, string> }
  | { readonly kind: "method"; readonly allow: readonly HttpMethod[] }
  | { readonly kind: "none" };

export function matchRoute(routes: readonly Route[], method: string, pathname: string): RouteMatch {
  const allow: HttpMethod[] = [];
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    if (route.method !== method) {
      allow.push(route.method);
      continue;
    }
    const rawParams: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      rawParams[name] = match[index + 1]!;
    });
    return { kind: "match", route, rawParams };
  }
  return allow.length > 0 ? { kind: "method", allow } : { kind: "none" };
}
