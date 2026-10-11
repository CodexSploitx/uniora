import { UnioraApiError, UnioraConnectionError } from "./errors.js";
import type { ApiIssue } from "./errors.js";
import { OPERATIONS } from "./generated.js";
import type { OperationId, Operations } from "./generated.js";

/** The end user a delegated call speaks for, as your auth provider knows them (asserted). Never copy it from what the end user sent. */
export interface AssertedActor {
  readonly subject: string;
  /** The opaque label of the identity provider. Omit it to use the server's default label. */
  readonly provider?: string;
  readonly token?: never;
}

/** The end user's own token from your identity provider: the server verifies it and takes the identity from it. */
export interface VerifiedActor {
  readonly token: string;
  readonly subject?: never;
  readonly provider?: never;
}

/** Who a delegated call speaks for: prefer the verified form, which a leaked API key cannot forge. */
export type Actor = AssertedActor | VerifiedActor;

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
type TokenTaken<K extends OperationId> = Meta<K>["actorToken"] extends true ? { readonly actorToken?: string } : unknown;
type Versioned<K extends OperationId> = Meta<K>["ifMatch"] extends true ? { readonly ifMatch?: number } : unknown;
type Idempotent<K extends OperationId> = Meta<K>["idempotent"] extends true ? { readonly idempotencyKey?: string } : unknown;

/** The options of one operation: the common ones, plus the actor when it is a delegated call, `ifMatch` when it takes a version and `idempotencyKey` when it takes one. */
export type OptionsOf<K extends OperationId> = CallOptions & Delegated<K> & TokenTaken<K> & Versioned<K> & Idempotent<K>;
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
  // A page (window or document) or a worker of a page: either way the code is delivered to a browser and the key would be public.
  const scope = globalThis as { window?: { document?: unknown }; document?: unknown; WorkerGlobalScope?: unknown };
  const browser = scope.window?.document !== undefined || scope.document !== undefined || typeof scope.WorkerGlobalScope === "function";
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
  assertLimits(options.timeoutMs, options.retries);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("No fetch available: use Node 20 or newer, or pass `fetch`.");
  return { base: url.origin + url.pathname.replace(/\/+$/, ""), fetchImpl };
}

/** `timeoutMs` and `retries`, as given to the client or to one call: whole numbers in range, never `Infinity` (a retry loop that does not end). */
function assertLimits(timeoutMs: unknown, retries: unknown): void {
  for (const [name, value, min, max] of [["timeoutMs", timeoutMs, 1, 600_000], ["retries", retries, 0, 10]] as const) {
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)) throw new TypeError(`\`${name}\` must be an integer from ${min} to ${max}.`);
  }
}

const CODE = /^[a-z0-9_]{1,64}$/;
const REQUEST_ID = /^req_[A-Za-z0-9_-]{1,64}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Waits for `sleeping`, or until the caller aborts, whichever comes first. */
function pause(sleeping: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return sleeping;
  return new Promise<void>((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    void sleeping.then(done, done);
  });
}

function parseProblem(status: number, body: unknown, headers: Headers): UnioraApiError {
  const retryAfter = Number(headers.get("retry-after"));
  // What the server says goes into an error message and a log line: only text of the shape it really has.
  const header = headers.get("request-id");
  const base = { status, requestId: header !== null && REQUEST_ID.test(header) ? header : undefined, retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined };
  if (isRecord(body) && typeof body.code === "string" && CODE.test(body.code)) {
    const issues = Array.isArray(body.errors)
      ? body.errors.slice(0, 50).filter((issue): issue is ApiIssue => isRecord(issue) && typeof issue.path === "string" && issue.path.length <= 200 && typeof issue.code === "string" && CODE.test(issue.code))
      : [];
    return new UnioraApiError({ ...base, code: body.code, requestId: typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : base.requestId, issues });
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
      // `.` and `..` are not ids: the URL machinery would fold them into the path and call another operation.
      if (value === "." || value === "..") throw new TypeError(`${operationId}: "${name}" is not a valid id.`);
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
    const actorToken = callOptions.actorToken as string | undefined;
    if (operation.delegated) {
      const verified = actor !== undefined && typeof actor.token === "string" && actor.token !== "";
      const asserted = actor !== undefined && typeof actor.subject === "string" && actor.subject !== "";
      if (verified === asserted) throw new TypeError(`${operationId}: this call speaks for an end user: pass { actor: { token } } (their token from your identity provider) or { actor: { subject } }, not both.`);
      if (verified) {
        headers["uniora-actor-token"] = (actor as VerifiedActor).token;
      } else {
        headers["uniora-actor-subject"] = encodeURIComponent((actor as AssertedActor).subject);
        const provider = (actor as AssertedActor).provider;
        if (provider !== undefined) {
          if (typeof provider !== "string" || !PROVIDER.test(provider)) throw new TypeError(`${operationId}: the actor's provider is not a valid label.`);
          headers["uniora-actor-provider"] = provider;
        }
      }
    } else if (actor !== undefined) {
      throw new TypeError(`${operationId}: this call does not speak for a user, so it takes no actor.`);
    }
    if (actorToken !== undefined) {
      if (!operation.actorToken) throw new TypeError(`${operationId}: this call takes no actor token.`);
      if (typeof actorToken !== "string" || actorToken === "") throw new TypeError(`${operationId}: \`actorToken\` must be the end user's token.`);
      headers["uniora-actor-token"] = actorToken;
    }
    if (callOptions.ifMatch !== undefined) {
      if (!operation.ifMatch) throw new TypeError(`${operationId}: this call takes no version.`);
      if (typeof callOptions.ifMatch !== "number" || !Number.isInteger(callOptions.ifMatch) || callOptions.ifMatch < 0) throw new TypeError(`${operationId}: \`ifMatch\` is the version number you last saw.`);
      headers["if-match"] = `"${callOptions.ifMatch}"`;
    }

    assertLimits(callOptions.timeoutMs, callOptions.retries);
    const retries = (callOptions.retries as number | undefined) ?? defaults.retries;
    const timeoutMs = (callOptions.timeoutMs as number | undefined) ?? defaults.timeoutMs;
    let idempotencyKey = callOptions.idempotencyKey as string | undefined;
    if (idempotencyKey !== undefined && !operation.idempotent) throw new TypeError(`${operationId}: this call takes no idempotency key.`);
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey))) throw new TypeError(`${operationId}: \`idempotencyKey\` is 1 to 128 letters, digits and ._:-`);
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
        // A server in read-only mode will not take this however often it is asked, and a wait longer than the call's own
        // time limit is not a retry the caller asked for.
        const retryable = problem.code !== "read_only" && (REJECTED_UP_FRONT.has(problem.code) || (repeatable && TRANSIENT_STATUS.has(problem.status)));
        const asked = problem.retryAfterSeconds !== undefined ? Math.min(problem.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
        if (!retryable || attempt >= retries || (asked !== undefined && asked > timeoutMs)) throw problem;
        failure = problem;
        wait = asked;
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
      await pause(sleep(wait ?? Math.floor(Math.random() * Math.min(MAX_BACKOFF_MS, 200 * 2 ** attempt))), outer);
      if (outer?.aborted) throw new UnioraConnectionError("The call was aborted.", { cause: outer.reason });
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
