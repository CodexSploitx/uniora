import { UnioraApiError, UnioraConnectionError } from "./errors.js";
import type { ApiIssue } from "./errors.js";
import { OPERATIONS } from "./generated.js";
import type { OperationId, Operations } from "./generated.js";

/** The end user a delegated call speaks for, as your auth provider knows them. Never copy it from what the end user sent. */
export interface Actor {
  readonly subject: string;
  /** The opaque label of the identity provider. Omit it to use the server's default label. */
  readonly provider?: string;
}

export interface UnioraClientOptions {
  /** Where your UNIORA server is: `https://uniora.internal.example.com`. */
  readonly baseUrl: string;
  /** The API key (`uniora_sk_…`). A secret: keep it on your server, never in a browser, a repository or a log. */
  readonly apiKey: string;
  /** Milliseconds before a call is given up. Default 10 000. */
  readonly timeoutMs?: number;
  /** How many times a call that is safe to repeat is retried. Default 2. `0` turns retries off. */
  readonly retries?: number;
  /** Plain `http:` is refused except to this machine, because the key would travel in the clear. Set it only for a private network you control. */
  readonly allowInsecureHttp?: boolean;
  /** The client refuses to run in a browser, where the key would be public. This switch exists for tests and for server-side runtimes that look like one. */
  readonly dangerouslyAllowBrowser?: boolean;
  /** Replace `fetch` (tests, proxies, instrumentation). */
  readonly fetch?: typeof fetch;
  /** Replace the wait between retries (tests). */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** Options every call accepts. */
export interface CallOptions {
  readonly signal?: AbortSignal;
  /** Overrides the client's `timeoutMs` for this call. */
  readonly timeoutMs?: number;
  /** Overrides the client's `retries` for this call. */
  readonly retries?: number;
}

type Meta<K extends OperationId> = (typeof OPERATIONS)[K];
type Delegated<K extends OperationId> = Meta<K>["delegated"] extends true ? { readonly actor: Actor } : { readonly actor?: never };
type Versioned<K extends OperationId> = Meta<K>["ifMatch"] extends true ? { readonly ifMatch?: number } : unknown;
type Idempotent<K extends OperationId> = Meta<K>["idempotent"] extends true ? { readonly idempotencyKey?: string } : unknown;

/** The options of one operation: the common ones, plus the actor when it is a delegated call, `ifMatch` when it takes a version and `idempotencyKey` when it takes one. */
export type OptionsOf<K extends OperationId> = CallOptions & Delegated<K> & Versioned<K> & Idempotent<K>;
export type InputOf<K extends OperationId> = Operations[K]["input"];
export type OutputOf<K extends OperationId> = Operations[K]["output"];

type NeedsInput<T> = Record<string, never> extends T ? false : {} extends T ? false : true;
type Args<K extends OperationId> = NeedsInput<InputOf<K>> extends true
  ? Meta<K>["delegated"] extends true
    ? [input: InputOf<K>, options: OptionsOf<K>]
    : [input: InputOf<K>, options?: OptionsOf<K>]
  : Meta<K>["delegated"] extends true
    ? [input: InputOf<K> | undefined, options: OptionsOf<K>]
    : [input?: InputOf<K>, options?: OptionsOf<K>];

type Group<K extends string> = K extends `${infer G}.${string}` ? G : never;
type Method<K extends string, G extends string> = K extends `${G}.${infer M}` ? M : never;

/** `client.members.assignRole(...)`: every operation of the API, grouped, with its input and output typed. */
export type UnioraApi = {
  readonly [G in Group<OperationId>]: {
    readonly [K in OperationId as Method<K, G>]: (...args: Args<K>) => Promise<OutputOf<K>>;
  };
};

export type UnioraClient = UnioraApi & {
  /** Calls an operation by its id. The grouped methods are this with the id split in two. */
  call<K extends OperationId>(operation: K, ...args: Args<K>): Promise<OutputOf<K>>;
};

const KEY_SHAPE = /^uniora_sk_[A-Za-z0-9_-]{20,}$/;
const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\])$/;
const MAX_BACKOFF_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;
/** Rejected before any handler ran: repeating them cannot repeat a change. */
const REJECTED_UP_FRONT = new Set(["rate_limited", "overloaded", "unavailable"]);
const TRANSIENT_STATUS = new Set([502, 503, 504]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function validate(options: UnioraClientOptions): { base: string; fetchImpl: typeof fetch } {
  if (!options || typeof options !== "object") throw new TypeError("createUnioraClient needs an options object.");
  const browser = (globalThis as { window?: { document?: unknown } }).window?.document !== undefined;
  if (browser && options.dangerouslyAllowBrowser !== true) {
    throw new Error("@uniora/client holds an API key and must run on your server, never in a browser: the key would be public. Call your own backend from the browser instead.");
  }
  if (typeof options.apiKey !== "string" || !KEY_SHAPE.test(options.apiKey)) throw new TypeError('`apiKey` must be an API key ("uniora_sk_…").');
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new TypeError("`baseUrl` must be a URL such as https://uniora.internal.example.com.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (LOOPBACK.test(url.hostname) || options.allowInsecureHttp === true))) {
    throw new TypeError("`baseUrl` must be https: the API key would travel in the clear. (`allowInsecureHttp` allows plain http on a private network.)");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new TypeError("`baseUrl` must not carry credentials, a query or a fragment.");
  for (const [name, value, min] of [["timeoutMs", options.timeoutMs, 1], ["retries", options.retries, 0]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > 600_000)) throw new TypeError(`\`${name}\` must be an integer of at least ${min}.`);
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch available: use Node 20 or newer, or pass `fetch`.");
  return { base: url.origin + url.pathname.replace(/\/+$/, ""), fetchImpl };
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function parseProblem(status: number, body: unknown, headers: Headers): UnioraApiError {
  const retryAfter = Number(headers.get("retry-after"));
  const base = { status, requestId: headers.get("request-id") ?? undefined, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined };
  if (isRecord(body) && typeof body.code === "string") {
    const issues = Array.isArray(body.errors) ? body.errors.filter((issue): issue is ApiIssue => isRecord(issue) && typeof issue.path === "string" && typeof issue.code === "string") : [];
    return new UnioraApiError({ ...base, code: body.code, requestId: typeof body.requestId === "string" ? body.requestId : base.requestId, issues });
  }
  return new UnioraApiError({ ...base, code: "unexpected_response" });
}

/**
 * The client of the UNIORA API.
 *
 * ```ts
 * const uniora = createUnioraClient({ baseUrl: process.env.UNIORA_URL!, apiKey: process.env.UNIORA_API_KEY! });
 * const { allowed } = await uniora.decisions.check({ identity: { subject: user.id }, organizationId, permission: "vehicles.delete" });
 * await uniora.members.assignRole({ organizationId, membershipId, roleId }, { actor: { subject: session.userId } });
 * ```
 *
 * Calls that change nothing are retried on network errors and transient failures; calls that change something are retried only
 * when that cannot repeat the change (the server refused them up front, or they carry an `Idempotency-Key`, which the client adds
 * by itself for the operations that take one). Errors are `UnioraApiError`s carrying the same stable `code`s as the libraries.
 */
export function createUnioraClient(options: UnioraClientOptions): UnioraClient {
  const { base, fetchImpl } = validate(options);
  const sleep = options.sleep ?? defaultSleep;
  const defaults = { timeoutMs: options.timeoutMs ?? 10_000, retries: options.retries ?? 2 };

  async function call(operationId: OperationId, input: unknown, callOptions: Record<string, unknown> = {}): Promise<unknown> {
    const operation = OPERATIONS[operationId];
    if (!operation) throw new TypeError(`Unknown operation "${String(operationId)}".`);
    const values = input === undefined ? {} : input;
    if (!isRecord(values)) throw new TypeError(`${operationId}: the input must be an object.`);
    const known = new Set<string>([...operation.pathParams, ...operation.query, ...operation.body]);
    for (const key of Object.keys(values)) if (!known.has(key)) throw new TypeError(`${operationId}: unknown input "${key}".`);

    let path: string = operation.path;
    for (const name of operation.pathParams) {
      const value = values[name];
      if (typeof value !== "string" || value === "") throw new TypeError(`${operationId}: "${name}" is required.`);
      path = path.replace(`:${name}`, encodeURIComponent(value));
    }
    const query = new URLSearchParams();
    for (const name of operation.query) {
      const value = values[name];
      if (value !== undefined) query.set(name, String(value));
    }
    const headers: Record<string, string> = { authorization: `Bearer ${options.apiKey}`, accept: "application/json", "user-agent": "uniora-client" };
    let body: string | undefined;
    if (operation.hasBody) {
      const payload: Record<string, unknown> = {};
      for (const name of operation.body) if (values[name] !== undefined) payload[name] = values[name];
      body = JSON.stringify(payload);
      headers["content-type"] = "application/json";
    }
    const actor = callOptions.actor as Actor | undefined;
    if (operation.delegated) {
      if (!actor || typeof actor.subject !== "string" || actor.subject === "") throw new TypeError(`${operationId}: this call speaks for an end user: pass { actor: { subject } }.`);
      headers["uniora-actor-subject"] = encodeURIComponent(actor.subject);
      if (actor.provider !== undefined) headers["uniora-actor-provider"] = actor.provider;
    } else if (actor !== undefined) {
      throw new TypeError(`${operationId}: this call does not speak for a user, so it takes no actor.`);
    }
    if (callOptions.ifMatch !== undefined) {
      if (!operation.ifMatch) throw new TypeError(`${operationId}: this call takes no version.`);
      headers["if-match"] = `"${String(callOptions.ifMatch)}"`;
    }

    const retries = (callOptions.retries as number | undefined) ?? defaults.retries;
    const timeoutMs = (callOptions.timeoutMs as number | undefined) ?? defaults.timeoutMs;
    let idempotencyKey = callOptions.idempotencyKey as string | undefined;
    if (idempotencyKey !== undefined && !operation.idempotent) throw new TypeError(`${operationId}: this call takes no idempotency key.`);
    // A retry of a call that creates something is safe only with a key: add one for this logical call (every attempt reuses it).
    if (operation.idempotent && idempotencyKey === undefined && retries > 0) idempotencyKey = crypto.randomUUID();
    if (idempotencyKey !== undefined) headers["idempotency-key"] = idempotencyKey;
    const repeatable = operation.safe || idempotencyKey !== undefined;

    const url = `${base}${path}${query.size > 0 ? `?${query.toString()}` : ""}`;
    const outer = callOptions.signal as AbortSignal | undefined;

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      const onAbort = () => controller.abort(outer?.reason);
      outer?.addEventListener("abort", onAbort, { once: true });
      let failure: UnioraApiError | UnioraConnectionError;
      let wait: number | undefined;
      try {
        if (outer?.aborted) throw outer.reason ?? new Error("aborted");
        const response = await fetchImpl(url, { method: operation.method, headers, ...(body !== undefined ? { body } : {}), signal: controller.signal, redirect: "error" });
        const text = await response.text();
        let parsed: unknown;
        if (text !== "") {
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = undefined;
          }
        }
        if (response.ok) {
          if (text === "") return undefined;
          if (parsed === undefined) throw new UnioraApiError({ status: response.status, code: "invalid_response", requestId: response.headers.get("request-id") ?? undefined });
          return parsed;
        }
        const problem = parseProblem(response.status, parsed, response.headers);
        const retryable = REJECTED_UP_FRONT.has(problem.code) || (repeatable && TRANSIENT_STATUS.has(problem.status));
        if (!retryable || attempt >= retries) throw problem;
        failure = problem;
        wait = problem.retryAfterSeconds !== undefined ? Math.min(problem.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
      } catch (error) {
        if (error instanceof UnioraApiError) throw error;
        if (outer?.aborted) throw new UnioraConnectionError("The call was aborted.", { cause: error });
        const timedOut = controller.signal.aborted;
        const connection = new UnioraConnectionError(timedOut ? `No answer from the UNIORA server within ${timeoutMs} ms.` : "Could not reach the UNIORA server.", { cause: error });
        if (!repeatable || attempt >= retries) throw connection;
        failure = connection;
      } finally {
        clearTimeout(timer);
        outer?.removeEventListener("abort", onAbort);
      }
      void failure;
      await sleep(wait ?? Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, 200 * 2 ** attempt)));
    }
  }

  const api: Record<string, Record<string, unknown>> = {};
  for (const operationId of Object.keys(OPERATIONS) as OperationId[]) {
    const [group, method] = operationId.split(".") as [string, string];
    (api[group] ??= {})[method] = (input?: unknown, callOptions?: Record<string, unknown>) => call(operationId, input, callOptions);
  }
  return Object.assign(Object.create(null) as object, api, { call: (operationId: OperationId, input?: unknown, callOptions?: Record<string, unknown>) => call(operationId, input, callOptions) }) as unknown as UnioraClient;
}

/** Walks every item of a paged operation: `for await (const member of paginate((cursor) => uniora.members.list({ organizationId, cursor })))`. */
export async function* paginate<T>(page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>): AsyncGenerator<T, void, void> {
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    yield* result.items;
    cursor = result.nextCursor ?? undefined;
  } while (cursor !== undefined);
}
