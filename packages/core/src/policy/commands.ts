import type { Identity } from "../identity/types.js";
import { PolicyError } from "./errors.js";
import type { PolicyService } from "./service.js";

/**
 * Everything a request handler may ask of the policy service. A handler runs one of these as
 * `runPolicyCommand(service, command, { actor, organizationId }, params)`: the actor and the organization come from YOUR
 * authentication and session, never from the request body, and `params` is untrusted input that is checked field by field.
 * Nothing in `params` can name another actor, smuggle an `authorization`, or reach the repositories: unknown fields are rejected.
 * The definition itself is validated by the policy language (`parsePolicyDefinition`), which is strict.
 */
export const POLICY_COMMANDS = [
  "createPolicy",
  "updatePolicy",
  "activatePolicy",
  "disablePolicy",
  "retirePolicy",
  "deletePolicy",
  "getPolicy",
  "listPolicies",
  "listRevisions",
  "validatePolicy",
  "simulate",
] as const;
export type PolicyCommand = (typeof POLICY_COMMANDS)[number];

export function isPolicyCommand(value: unknown): value is PolicyCommand {
  return typeof value === "string" && (POLICY_COMMANDS as readonly string[]).includes(value);
}

export interface PolicyCommandContext {
  /** The authenticated caller. */
  actor: Identity;
  /** The organization the caller is working in (from the session or the route; the service still checks the caller's rights in it). */
  organizationId: string;
}

type Kind = "string" | "string?" | "string|null?" | "number?" | "object" | "object?" | "boolean?" | "identity" | "pageLimit?";
type Shape = Record<string, Kind>;

const SHAPES: Record<PolicyCommand, Shape> = {
  createPolicy: { id: "string?", key: "string", name: "string", description: "string?", definition: "object", note: "string?" },
  updatePolicy: { policyId: "string", name: "string?", description: "string|null?", definition: "object?", note: "string?", expectedVersion: "number?" },
  activatePolicy: { policyId: "string", reason: "string?", expectedVersion: "number?" },
  disablePolicy: { policyId: "string", reason: "string?", expectedVersion: "number?" },
  retirePolicy: { policyId: "string", reason: "string?", expectedVersion: "number?" },
  deletePolicy: { policyId: "string" },
  getPolicy: { policyId: "string" },
  listPolicies: { status: "string?", kind: "string?", effect: "string?", query: "string?", limit: "pageLimit?", after: "string?" },
  listRevisions: { policyId: "string", limit: "pageLimit?", before: "number?" },
  validatePolicy: { definition: "object" },
  simulate: {
    identity: "identity",
    permission: "string",
    teamId: "string?",
    resource: "object?",
    requireApplicablePolicy: "boolean?",
    candidate: "object?",
  },
};

const bad = (message: string) => new PolicyError(message, "policy_invalid");
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 2000): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

function check(name: string, kind: Kind, value: unknown): unknown {
  const optional = kind.endsWith("?");
  if (value === undefined) {
    if (optional) return undefined;
    throw bad(`"${name}" is required.`);
  }
  const base = optional ? kind.slice(0, -1) : kind;
  switch (base) {
    case "string":
      // Names and notes are sanitized (and bounded) by the policy language; this only keeps absurd input out.
      if (isText(value, 20_000)) return value;
      break;
    case "string|null":
      if (value === null || isText(value, 20_000)) return value;
      break;
    case "number":
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
      break;
    case "pageLimit":
      if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000) return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "object":
      if (isPlainObject(value)) return value;
      break;
    case "identity":
      if (isPlainObject(value) && Object.keys(value).every((key) => key === "provider" || key === "subject") && isText(value.provider, 200) && isText(value.subject, 500)) {
        return { provider: value.provider, subject: value.subject };
      }
      break;
  }
  throw bad(`"${name}" is not valid.`);
}

/** Keeps only what the command declares and checks each field; an unknown field is an error, never silently passed on. */
function clean(command: PolicyCommand, params: unknown): Record<string, unknown> {
  if (!isPlainObject(params)) throw bad("The request must be a JSON object.");
  const shape = SHAPES[command];
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(shape, key)) throw bad(`Unknown field "${key}".`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(shape)) {
    const value = check(name, kind, Object.hasOwn(params, name) ? params[name] : undefined);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Validates `params` and runs the command on the policy service as `context.actor`, returning a JSON-safe result (dates as ISO
 * strings). Authorization is the service's: this function adds input checking and a fixed door, not permissions. Failures are
 * `PolicyError`s; `policyErrorToHttp` turns them into responses.
 */
export async function runPolicyCommand(service: PolicyService, command: string, context: PolicyCommandContext, params: unknown): Promise<unknown> {
  if (!isPolicyCommand(command)) throw bad(`Unknown policy command "${String(command)}".`);
  const input = clean(command, params);
  const who = { actor: context.actor, organizationId: context.organizationId };
  const id = () => (typeof input.id === "string" ? input.id : crypto.randomUUID());
  let result: unknown;
  switch (command) {
    case "createPolicy":
      result = await service.createPolicy({ ...who, ...(input as object), id: id() } as Parameters<PolicyService["createPolicy"]>[0]);
      break;
    case "updatePolicy":
      result = await service.updatePolicy({ ...who, ...(input as object) } as Parameters<PolicyService["updatePolicy"]>[0]);
      break;
    case "activatePolicy":
      result = await service.activatePolicy({ ...who, ...(input as object) } as Parameters<PolicyService["activatePolicy"]>[0]);
      break;
    case "disablePolicy":
      result = await service.disablePolicy({ ...who, ...(input as object) } as Parameters<PolicyService["disablePolicy"]>[0]);
      break;
    case "retirePolicy":
      result = await service.retirePolicy({ ...who, ...(input as object) } as Parameters<PolicyService["retirePolicy"]>[0]);
      break;
    case "deletePolicy":
      await service.deletePolicy({ ...who, policyId: input.policyId as string });
      result = { deleted: true };
      break;
    case "getPolicy":
      result = await service.getPolicy({ ...who, policyId: input.policyId as string });
      break;
    case "listPolicies":
      result = await service.listPolicies({ ...who, ...(input as object) } as Parameters<PolicyService["listPolicies"]>[0]);
      break;
    case "listRevisions":
      result = await service.listRevisions({ ...who, ...(input as object) } as Parameters<PolicyService["listRevisions"]>[0]);
      break;
    case "validatePolicy":
      result = await service.validate({ ...who, definition: input.definition });
      break;
    case "simulate":
      result = await service.simulate({ ...who, ...(input as object) } as Parameters<PolicyService["simulate"]>[0]);
      break;
  }
  return JSON.parse(JSON.stringify(result));
}

export interface PolicyHttpError {
  status: 400 | 401 | 403 | 404 | 409 | 500;
  body: { error: string; message: string };
}

const CONFLICT = new Set([
  "policy_exists",
  "policy_key_taken",
  "policy_version_conflict",
  "policy_transition_invalid",
  "policy_retired",
  "policy_not_draft",
  "policy_limit_reached",
]);
const NOT_FOUND = new Set(["policy_not_found", "policy_revision_not_found", "policy_organization_unknown"]);

/**
 * Maps a `PolicyError` to the response a route should send, or `null` for anything else (a bug or an outage: let it propagate).
 * A refusal never says why beyond "forbidden", so the answer can't be used to probe policies you may not see.
 */
export function policyErrorToHttp(error: unknown): PolicyHttpError | null {
  if (!(error instanceof PolicyError)) return null;
  const code = error.code;
  if (code === "policy_forbidden") {
    return { status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } };
  }
  // The caller is allowed in general, just not for this one (they wrote the policy they want to publish): telling them why helps.
  if (code === "policy_separation_of_duties") return { status: 403, body: { error: code, message: error.message } };
  if (code === "policy_authorization_required") {
    // The storage refused a write the service should have authorized: a programming error, not the caller's.
    return { status: 500, body: { error: "internal_error", message: "Something went wrong." } };
  }
  if (NOT_FOUND.has(code)) return { status: 404, body: { error: code, message: error.message } };
  if (CONFLICT.has(code)) return { status: 409, body: { error: code, message: error.message } };
  return { status: 400, body: { error: code, message: error.message } };
}
