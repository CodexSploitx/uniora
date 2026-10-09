import type { Identity } from "../identity/types.js";
import { MembershipError } from "../membership/repository.js";
import { RoleError } from "../role/repository.js";
import { InvitationError } from "../invitation/repository.js";
import { invitationErrorToHttp } from "../invitation/http.js";
import type { InvitationService } from "../invitation/service.js";
import { AccessError } from "./errors.js";
import type { AccessAdminService } from "./service.js";

/**
 * Everything a request handler may ask of the access and invitation services. A handler runs one of these as
 * `runAccessCommand({ access, invitations }, command, { actor, organizationId }, params)`: the actor and the organization come
 * from YOUR authentication and session, never from the request body, and `params` is untrusted input checked field by field.
 * Nothing in `params` can name another actor, smuggle an `authorization`, pick another organization or reach the repositories:
 * unknown fields are rejected.
 */
export const ACCESS_COMMANDS = [
  "assignRole",
  "unassignRole",
  "blockMember",
  "suspendMember",
  "unblockMember",
  "removeMember",
  "createRole",
  "updateRole",
  "setRolePermissions",
  "grantRolePermission",
  "revokeRolePermission",
  "cloneRole",
  "deleteRole",
  "inviteMember",
  "resendInvitation",
  "revokeInvitation",
] as const;
export type AccessCommand = (typeof ACCESS_COMMANDS)[number];

export function isAccessCommand(value: unknown): value is AccessCommand {
  return typeof value === "string" && (ACCESS_COMMANDS as readonly string[]).includes(value);
}

export interface AccessCommandContext {
  /** The authenticated caller. */
  actor: Identity;
  /** The organization the caller is working in (from the session or the route; the services still check the caller's rights in it). */
  organizationId: string;
  /**
   * `inviteMember` and `resendInvitation` return the accept link only when this is `true` (default `false`): a host that sends the
   * e-mail itself has no reason to show the secret link to the person who invited.
   */
  includeAcceptUrl?: boolean;
}

export interface AccessServices {
  access: AccessAdminService;
  /** Needed only for `inviteMember`, `resendInvitation` and `revokeInvitation`. */
  invitations?: InvitationService;
}

type Kind = "string" | "string?" | "string|null?" | "number?" | "boolean?" | "strings" | "strings?" | "date" | "deleteMembers?";
type Shape = Record<string, Kind>;

const MEMBER: Shape = { membershipId: "string", expectedVersion: "number?" };

const SHAPES: Record<AccessCommand, Shape> = {
  assignRole: { ...MEMBER, roleId: "string" },
  unassignRole: { ...MEMBER, roleId: "string" },
  blockMember: { ...MEMBER, reason: "string?" },
  suspendMember: { ...MEMBER, until: "date", reason: "string?" },
  unblockMember: { ...MEMBER },
  removeMember: { membershipId: "string" },
  createRole: { id: "string?", name: "string", key: "string?", description: "string?", permissionKeys: "strings?" },
  updateRole: { roleId: "string", name: "string?", description: "string|null?", expectedVersion: "number?" },
  setRolePermissions: { roleId: "string", permissionKeys: "strings", expectedVersion: "number?" },
  grantRolePermission: { roleId: "string", permissionKey: "string" },
  revokeRolePermission: { roleId: "string", permissionKey: "string" },
  cloneRole: { roleId: "string", id: "string?", name: "string", key: "string?", description: "string?" },
  deleteRole: { roleId: "string", members: "deleteMembers?" },
  inviteMember: { email: "string", roleIds: "strings", teamIds: "strings?", ttlMs: "number?", locale: "string?", idempotencyKey: "string?", allowExistingMember: "boolean?" },
  resendInvitation: { invitationId: "string", locale: "string?", ttlMs: "number?" },
  revokeInvitation: { invitationId: "string" },
};

const bad = (message: string) => new AccessError(message, "access_invalid");

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
      if (value === null || (typeof value === "string" && value.length > 0 && value.length <= 2000)) return value;
      break;
    case "number":
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "strings":
      if (Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2000)) return [...value];
      break;
    case "date": {
      // An ISO-8601 text or a number of milliseconds: never a Date (JSON has none), and never garbage.
      const date = typeof value === "string" || typeof value === "number" ? new Date(value) : undefined;
      if (date && !Number.isNaN(date.getTime())) return date;
      break;
    }
    case "deleteMembers":
      if (value === "detach" || value === "reject") return value;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        const keys = Object.keys(value);
        const reassignTo = (value as { reassignTo?: unknown }).reassignTo;
        if (keys.length === 1 && keys[0] === "reassignTo" && typeof reassignTo === "string" && reassignTo.length > 0 && reassignTo.length <= 2000) return { reassignTo };
      }
      break;
  }
  throw bad(`"${name}" is not valid.`);
}

/** Keeps only what the command declares and checks each field; an unknown field is an error, never silently passed on. */
function clean(command: AccessCommand, params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw bad("The request must be a JSON object.");
  const shape = SHAPES[command];
  const input = params as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(shape, key)) throw bad(`Unknown field "${key}".`);
  }
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(shape)) {
    const value = check(name, kind, Object.hasOwn(input, name) ? input[name] : undefined);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Validates `params` and runs the command as `context.actor`, returning a JSON-safe result (dates as ISO strings). Authorization
 * is the services': this function adds input checking and a fixed door, not permissions. Failures are `AccessError`s (and the
 * `MembershipError`, `RoleError` and `InvitationError` of the operations underneath); `accessErrorToHttp` turns them into responses.
 */
export async function runAccessCommand(services: AccessServices, command: string, context: AccessCommandContext, params: unknown): Promise<unknown> {
  if (!isAccessCommand(command)) throw bad(`Unknown access command "${String(command)}".`);
  const input = clean(command, params);
  const who = { actor: context.actor, organizationId: context.organizationId };
  const { access } = services;
  const invitations = (): InvitationService => {
    if (!services.invitations) throw bad("Invitations are not available on this route.");
    return services.invitations;
  };
  const withLink = <T extends { acceptUrl: string | null }>(result: T): Omit<T, "acceptUrl"> & { acceptUrl?: string | null } => {
    if (context.includeAcceptUrl === true) return result;
    const { acceptUrl: _hidden, ...rest } = result;
    return rest;
  };
  let result: unknown;
  switch (command) {
    case "assignRole":
      result = await access.assignRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["assignRole"]>[0]);
      break;
    case "unassignRole":
      result = await access.unassignRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["unassignRole"]>[0]);
      break;
    case "blockMember":
      result = await access.blockMember({ ...who, ...(input as object) } as Parameters<AccessAdminService["blockMember"]>[0]);
      break;
    case "suspendMember":
      result = await access.suspendMember({ ...who, ...(input as object) } as Parameters<AccessAdminService["suspendMember"]>[0]);
      break;
    case "unblockMember":
      result = await access.unblockMember({ ...who, ...(input as object) } as Parameters<AccessAdminService["unblockMember"]>[0]);
      break;
    case "removeMember":
      await access.removeMember({ ...who, membershipId: input.membershipId as string });
      result = { removed: true };
      break;
    case "createRole":
      result = await access.createRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["createRole"]>[0]);
      break;
    case "updateRole":
      result = await access.updateRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["updateRole"]>[0]);
      break;
    case "setRolePermissions":
      result = await access.setRolePermissions({ ...who, ...(input as object) } as Parameters<AccessAdminService["setRolePermissions"]>[0]);
      break;
    case "grantRolePermission":
      result = await access.grantRolePermission({ ...who, ...(input as object) } as Parameters<AccessAdminService["grantRolePermission"]>[0]);
      break;
    case "revokeRolePermission":
      result = await access.revokeRolePermission({ ...who, ...(input as object) } as Parameters<AccessAdminService["revokeRolePermission"]>[0]);
      break;
    case "cloneRole":
      result = await access.cloneRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["cloneRole"]>[0]);
      break;
    case "deleteRole":
      await access.deleteRole({ ...who, ...(input as object) } as Parameters<AccessAdminService["deleteRole"]>[0]);
      result = { deleted: true };
      break;
    case "inviteMember": {
      const invited = await invitations().invite({ organizationId: who.organizationId, invitedBy: who.actor, ...(input as object) } as Parameters<InvitationService["invite"]>[0]);
      result = withLink(invited);
      break;
    }
    case "resendInvitation": {
      const { invitationId, ...rest } = input as { invitationId: string; locale?: string; ttlMs?: number };
      result = withLink(await invitations().resend({ organizationId: who.organizationId, invitationId, actor: who.actor }, rest));
      break;
    }
    case "revokeInvitation":
      result = await invitations().revoke({ organizationId: who.organizationId, invitationId: input.invitationId as string, actor: who.actor });
      break;
  }
  return JSON.parse(JSON.stringify(result));
}

export interface AccessHttpError {
  status: 400 | 403 | 404 | 409 | 429 | 500;
  body: { error: string; message: string; reason?: string };
}

const NOT_FOUND = new Set(["membership_not_found", "role_not_found"]);
const CONFLICT = new Set([
  "membership_version_conflict",
  "role_version_conflict",
  "last_owner",
  "role_exists",
  "role_key_exists",
  "role_in_use",
  "membership_exists",
]);

/**
 * Maps what an access command can throw to the response a route should send, or `null` for anything else (a bug or an outage:
 * let it propagate). Someone without the permission gets a plain `403 forbidden`; someone who has it but was stopped by one of
 * the four rules gets the same `403` with a `reason` (`access_escalation`, `access_self_change`, `access_target_stronger`,
 * `access_owner_protected`) so a screen can explain it; the answer never says more about the target than the caller already named.
 */
export function accessErrorToHttp(error: unknown): AccessHttpError | null {
  if (error instanceof AccessError) {
    switch (error.code) {
      case "access_forbidden":
        return { status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } };
      case "access_self_change":
      case "access_escalation":
      case "access_target_stronger":
      case "access_owner_protected":
        return { status: 403, body: { error: "forbidden", reason: error.code, message: error.message } };
      case "access_invalid":
        return { status: 400, body: { error: error.code, message: error.message } };
      default:
        // The storage refused a write the services should have authorized, or the service was wired to an unguarded storage: a
        // programming error, not the caller's.
        return { status: 500, body: { error: "internal_error", message: "Something went wrong." } };
    }
  }
  if (error instanceof InvitationError) return invitationErrorToHttp(error);
  if (error instanceof MembershipError || error instanceof RoleError) {
    const code = error.code;
    if (NOT_FOUND.has(code)) return { status: 404, body: { error: code, message: error.message } };
    if (CONFLICT.has(code)) return { status: 409, body: { error: code, message: error.message } };
    return { status: 400, body: { error: code, message: error.message } };
  }
  return null;
}
