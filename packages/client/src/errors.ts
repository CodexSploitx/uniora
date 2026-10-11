/** One thing wrong with the request: where, and why. Never the value. */
export interface ApiIssue {
  readonly path: string;
  readonly code: string;
}

/**
 * The server answered, and said no. `code` is the stable code of the API (`forbidden`, `organization_not_found`,
 * `membership_version_conflict`...): branch on it, never on `message`. It is the same code the libraries throw.
 */
export class UnioraApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Quote it to whoever runs the server: the detail of the failure is in their log under it. */
  readonly requestId: string | undefined;
  /** On a `400 invalid_request`: where the input is wrong. */
  readonly issues: readonly ApiIssue[];
  /** Seconds to wait, when the server said (`429`, `503`). */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: { status: number; code: string; requestId?: string | undefined; issues?: readonly ApiIssue[] | undefined; retryAfterSeconds?: number | undefined }) {
    super(`UNIORA API ${init.status} ${init.code}${init.requestId ? ` (request ${init.requestId})` : ""}`);
    this.name = "UnioraApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.issues = init.issues ?? [];
    this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The server could not be reached, or did not answer in time. Whether the change happened is unknown unless the call was idempotent. */
export class UnioraConnectionError extends Error {
  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "UnioraConnectionError";
  }
}
