import { UnioraError } from "@uniora/core";
import type { Issue } from "./schema.js";

/**
 * An error the server answers on purpose. `title` is the standard HTTP reason phrase and NOTHING else: a message that names
 * an identity, an organization or a policy must never reach a response, because the caller may be a backend that forwards
 * errors to a browser. The detail goes to the server's log, keyed by the request id.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    options: { issues?: readonly Issue[]; headers?: Readonly<Record<string, string>>; cause?: unknown; detail?: string } = {},
  ) {
    super(options.detail ?? `${status} ${code}`);
    this.name = "ApiError";
    this.issues = options.issues;
    this.headers = options.headers ?? {};
    if (options.cause !== undefined) this.cause = options.cause;
  }
  readonly issues: readonly Issue[] | undefined;
  readonly headers: Readonly<Record<string, string>>;
}

const REASONS: Readonly<Record<number, string>> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  428: "Precondition Required",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  503: "Service Unavailable",
};

export const reasonPhrase = (status: number): string => REASONS[status] ?? "Error";

export const errors = {
  invalidRequest: (issues: readonly Issue[]) => new ApiError(400, "invalid_request", { issues }),
  invalidJson: () => new ApiError(400, "invalid_json"),
  unexpectedBody: () => new ApiError(400, "unexpected_body"),
  unauthenticated: () => new ApiError(401, "unauthenticated", { headers: { "WWW-Authenticate": 'Bearer realm="uniora"' } }),
  /** Never says why: not the missing scope, not the organization. */
  forbidden: () => new ApiError(403, "forbidden"),
  notFound: (code = "not_found") => new ApiError(404, code),
  methodNotAllowed: (allow: readonly string[]) => new ApiError(405, "method_not_allowed", { headers: { Allow: allow.join(", ") } }),
  conflict: (code: string) => new ApiError(409, code),
  preconditionFailed: (code: string) => new ApiError(412, code),
  bodyTooLarge: () => new ApiError(413, "body_too_large", { headers: { Connection: "close" } }),
  unsupportedMediaType: () => new ApiError(415, "unsupported_media_type"),
  rateLimited: (retryAfterSeconds: number) => new ApiError(429, "rate_limited", { headers: { "Retry-After": String(retryAfterSeconds) } }),
  overloaded: (retryAfterSeconds = 1) => new ApiError(503, "overloaded", { headers: { "Retry-After": String(retryAfterSeconds) } }),
  timeout: () => new ApiError(503, "timeout"),
  readOnly: () => new ApiError(503, "read_only", { headers: { "Retry-After": "30" } }),
  notImplemented: (code: string) => new ApiError(501, code),
  internal: (cause?: unknown) => new ApiError(500, "internal_error", { cause }),
};

/** Codes that mean the SERVER is wired wrongly, never that the caller did something: a guarded write without its proof, an unguarded storage. */
const SERVER_FAULT = /_authorization_required$|^access_storage_not_guarded$/;

/** The HTTP status of a domain error, from the stable shape of its code. Unknown codes are the caller's fault (400), never a 5xx. */
export function statusForCode(code: string): number {
  if (/_not_found$|_unknown$/.test(code)) return 404;
  if (/_version_conflict$/.test(code)) return 412;
  if (/_forbidden$|_escalation$|_self_change$|_target_stronger$|_owner_protected$/.test(code)) return 403;
  if (/_rate_limited$|_cooldown$/.test(code)) return 429;
  if (/_exists$|_taken$|_conflict$|^last_owner$|_in_use$|_busy$|_already_member$|_duplicate_pending$|_has_children$|_not_archived$|_archived$|_transition_invalid$/.test(code)) return 409;
  return 400;
}

/** Turns anything thrown into the `ApiError` that is answered. Unknown errors become a bare 500: their detail stays in the log. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  // Compared by name as well: a bundler can load @uniora/core twice, and `instanceof` would then miss (see guides/errors.md).
  if (error instanceof UnioraError || (error instanceof Error && typeof (error as { code?: unknown }).code === "string" && /Error$/.test(error.name) && error.name !== "Error")) {
    const code = (error as UnioraError).code;
    if (SERVER_FAULT.test(code)) return errors.internal(error);
    // The plain "no" never says whether it was the permission, the role or the target: one code for all of them. The four
    // anti-escalation rules (`access_escalation`, ...) keep theirs: they describe the rule, not the target, and a screen needs them.
    if (/_forbidden$/.test(code)) return new ApiError(403, "forbidden", { cause: error, detail: error.message });
    return new ApiError(statusForCode(code), code, { cause: error, detail: error.message });
  }
  return errors.internal(error);
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  errors?: readonly Issue[];
}

/** RFC 9457 `application/problem+json`. */
export function problemOf(error: ApiError, requestId: string): Problem {
  return {
    type: `urn:uniora:error:${error.code}`,
    title: reasonPhrase(error.status),
    status: error.status,
    code: error.code,
    requestId,
    ...(error.issues && error.issues.length > 0 ? { errors: error.issues } : {}),
  };
}
