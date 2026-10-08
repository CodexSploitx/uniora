import type { Identity } from "../identity/types.js";
import { ORGANIZATION_STATUSES } from "../organization/types.js";
import { PlatformError } from "./errors.js";
import type { PlatformService } from "./service.js";
import { PLATFORM_MEMBER_STATUSES } from "./types.js";

/**
 * Everything a request handler of YOUR platform admin panel may ask of the platform service. A handler runs one of these as
 * `runPlatformCommand(service, command, { actor }, params)`: the actor comes from YOUR platform authentication, never from the
 * request body, and `params` is untrusted input checked field by field. Nothing in `params` can name another actor, smuggle an
 * `authorization` or reach the repositories: unknown fields are rejected.
 */
export const PLATFORM_COMMANDS = [
  "listRoles",
  "listMembers",
  "createRole",
  "updateRole",
  "deleteRole",
  "addMember",
  "suspendMember",
  "reactivateMember",
  "removeMember",
  "assignRole",
  "unassignRole",
  "listOrganizations",
  "setOrganizationStatus",
  "grantSupportAccess",
  "revokeSupportAccess",
] as const;
export type PlatformCommand = (typeof PLATFORM_COMMANDS)[number];

export function isPlatformCommand(value: unknown): value is PlatformCommand {
  return typeof value === "string" && (PLATFORM_COMMANDS as readonly string[]).includes(value);
}

export interface PlatformCommandContext {
  /** The authenticated caller, from the session of your platform admin panel. */
  actor: Identity;
}

type Kind = "string" | "string?" | "string|null?" | "number?" | "strings" | "strings?" | "memberStatus?" | "orgStatus?" | "orgStatus" | "date";
type Shape = Record<string, Kind>;

const SHAPES: Record<PlatformCommand, Shape> = {
  listRoles: { limit: "number?", after: "string?" },
  listMembers: { limit: "number?", after: "string?", status: "memberStatus?", roleId: "string?" },
  createRole: { id: "string?", key: "string", name: "string", description: "string?", permissions: "strings" },
  updateRole: { roleId: "string", name: "string?", description: "string|null?", permissions: "strings?", expectedVersion: "number?" },
  deleteRole: { roleId: "string" },
  addMember: { id: "string?", provider: "string", subject: "string", roleIds: "strings" },
  suspendMember: { memberId: "string", reason: "string?", expectedVersion: "number?" },
  reactivateMember: { memberId: "string", expectedVersion: "number?" },
  removeMember: { memberId: "string" },
  assignRole: { memberId: "string", roleId: "string", expectedVersion: "number?" },
  unassignRole: { memberId: "string", roleId: "string", expectedVersion: "number?" },
  listOrganizations: { limit: "number?", query: "string?", status: "orgStatus?" },
  setOrganizationStatus: { organizationId: "string", status: "orgStatus", reason: "string?" },
  grantSupportAccess: { id: "string?", organizationId: "string", permissions: "strings", reason: "string", expiresAt: "date" },
  revokeSupportAccess: { grantId: "string" },
};

const bad = (message: string) => new PlatformError(message, "platform_invalid");

function check(name: string, kind: Kind, value: unknown): unknown {
  const optional = kind.endsWith("?");
  if (value === undefined) {
    if (optional) return undefined;
    throw bad(`"${name}" is required.`);
  }
  const base = optional ? kind.slice(0, -1) : kind;
  switch (base) {
    case "string":
      if (typeof value === "string" && value.length > 0 && value.length <= 2000) return value;
      break;
    case "string|null":
      if (value === null || (typeof value === "string" && value.length <= 2000)) return value;
      break;
    case "number":
      if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000) return value;
      break;
    case "strings":
      if (Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2000)) return value;
      break;
    case "memberStatus":
      if ((PLATFORM_MEMBER_STATUSES as readonly unknown[]).includes(value)) return value;
      break;
    case "orgStatus":
      if ((ORGANIZATION_STATUSES as readonly unknown[]).includes(value)) return value;
      break;
    case "date": {
      const date = typeof value === "string" ? new Date(value) : null;
      if (date && !Number.isNaN(date.getTime())) return date;
      break;
    }
  }
  throw bad(`"${name}" is not valid.`);
}

/** Keeps only what the command declares and checks each field; an unknown field is an error, never silently passed on. */
function clean(command: PlatformCommand, params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) params = {};
  if (typeof params !== "object" || Array.isArray(params)) throw bad("The request must be a JSON object.");
  const shape = SHAPES[command];
  const input = params as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(key in shape)) throw bad(`Unknown field "${key}".`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(shape)) {
    const value = check(name, kind, input[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Validates `params` and runs the command on the platform service as `context.actor`, returning a JSON-safe result (dates as
 * ISO strings). Authorization is the service's: this adds input checking and a fixed door, not permissions. Failures are
 * `PlatformError`s (and the errors of the organization operations); `platformErrorToHttp` turns the platform ones into responses.
 */
export async function runPlatformCommand(service: PlatformService, command: string, context: PlatformCommandContext, params: unknown): Promise<unknown> {
  if (!isPlatformCommand(command)) throw bad(`Unknown platform command "${String(command)}".`);
  const input = clean(command, params);
  const who = { actor: context.actor };
  type A<K extends Exclude<keyof PlatformService, "engine">> = Parameters<PlatformService[K]>[0];
  let result: unknown;
  switch (command) {
    case "listRoles":
      result = await service.listRoles({ ...who, ...(input as object) } as A<"listRoles">);
      break;
    case "listMembers":
      result = await service.listMembers({ ...who, ...(input as object) } as A<"listMembers">);
      break;
    case "createRole":
      result = await service.createRole({ ...who, ...(input as object) } as A<"createRole">);
      break;
    case "updateRole":
      result = await service.updateRole({ ...who, ...(input as object) } as A<"updateRole">);
      break;
    case "deleteRole":
      await service.deleteRole({ ...who, roleId: input.roleId as string });
      result = { deleted: true };
      break;
    case "addMember":
      result = await service.addMember({
        ...who,
        ...(typeof input.id === "string" ? { id: input.id } : {}),
        identity: { provider: input.provider as string, subject: input.subject as string },
        roleIds: input.roleIds as string[],
      });
      break;
    case "suspendMember":
      result = await service.suspendMember({ ...who, ...(input as object) } as A<"suspendMember">);
      break;
    case "reactivateMember":
      result = await service.reactivateMember({ ...who, ...(input as object) } as A<"reactivateMember">);
      break;
    case "removeMember":
      await service.removeMember({ ...who, memberId: input.memberId as string });
      result = { removed: true };
      break;
    case "assignRole":
      result = await service.assignRole({ ...who, ...(input as object) } as A<"assignRole">);
      break;
    case "unassignRole":
      result = await service.unassignRole({ ...who, ...(input as object) } as A<"unassignRole">);
      break;
    case "listOrganizations":
      result = await service.listOrganizations({ ...who, ...(input as object) } as A<"listOrganizations">);
      break;
    case "setOrganizationStatus":
      result = await service.setOrganizationStatus({ ...who, ...(input as object) } as A<"setOrganizationStatus">);
      break;
    case "grantSupportAccess":
      result = await service.grantSupportAccess({ ...who, ...(input as object) } as A<"grantSupportAccess">);
      break;
    case "revokeSupportAccess":
      result = await service.revokeSupportAccess({ ...who, grantId: input.grantId as string });
      break;
  }
  return JSON.parse(JSON.stringify(result));
}

export interface PlatformHttpError {
  status: 400 | 401 | 403 | 404 | 409 | 428 | 500;
  body: { error: string; message: string };
}

const CONFLICT = new Set(["platform_role_exists", "platform_member_exists", "platform_role_in_use", "platform_version_conflict", "platform_last_admin", "platform_already_initialized"]);
const NOT_FOUND = new Set(["platform_role_not_found", "platform_member_not_found"]);
const FORBIDDEN = new Set(["platform_forbidden", "platform_escalation", "platform_self_change", "platform_role_system"]);

/**
 * Maps a `PlatformError` to the response a route should send, or `null` for anything else (a bug or an outage: let it
 * propagate). A refusal never says why beyond "forbidden"; `428` asks the client to re-authenticate (step-up).
 */
export function platformErrorToHttp(error: unknown): PlatformHttpError | null {
  if (!(error instanceof PlatformError)) return null;
  const code = error.code;
  if (FORBIDDEN.has(code)) return { status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } };
  if (code === "platform_step_up_required") return { status: 428, body: { error: code, message: "Please confirm your identity again to do this." } };
  if (code === "platform_authorization_required" || code === "platform_support_unavailable" || code === "platform_not_initialized") {
    // A programming or deployment error, not the caller's.
    return { status: 500, body: { error: "internal_error", message: "Something went wrong." } };
  }
  if (NOT_FOUND.has(code)) return { status: 404, body: { error: code, message: error.message } };
  if (CONFLICT.has(code)) return { status: 409, body: { error: code, message: error.message } };
  return { status: 400, body: { error: code, message: error.message } };
}
