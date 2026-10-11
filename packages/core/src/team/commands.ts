import type { Identity } from "../identity/types.js";
import { TeamError } from "./repository.js";
import type { TeamService } from "./service.js";
import type { TeamResponsibility } from "./types.js";

/**
 * Everything a request handler may ask of the team service. A handler runs one of these as `runTeamCommand(service, command,
 * { actor, organizationId }, params)`: the actor and the organization come from YOUR authentication and session, never from
 * the request body, and `params` is untrusted input that is checked field by field. Nothing in `params` can name another actor,
 * smuggle an `authorization`, or reach the repositories: unknown fields are rejected.
 */
export const TEAM_COMMANDS = [
  "createTeam",
  "updateTeam",
  "archiveTeam",
  "restoreTeam",
  "deleteTeam",
  "addMember",
  "acceptInvitation",
  "leaveTeam",
  "removeMember",
  "suspendMember",
  "reactivateMember",
  "setResponsibility",
  "assignRole",
  "unassignRole",
  "moveMember",
] as const;
export type TeamCommand = (typeof TEAM_COMMANDS)[number];

export function isTeamCommand(value: unknown): value is TeamCommand {
  return typeof value === "string" && (TEAM_COMMANDS as readonly string[]).includes(value);
}

export interface TeamCommandContext {
  /** The authenticated caller. */
  actor: Identity;
  /** The organization the caller is working in (from the session or the route; the service still checks the caller's rights in it). */
  organizationId: string;
}

type Kind = "string" | "string?" | "string|null?" | "number?" | "object?" | "strings?" | "responsibility" | "responsibility?" | "pendingOrActive?";
type Shape = Record<string, Kind>;

const SHAPES: Record<TeamCommand, Shape> = {
  createTeam: { id: "string?", name: "string", slug: "string?", externalId: "string?", parentId: "string?", metadata: "object?", settings: "object?" },
  updateTeam: { teamId: "string", name: "string?", slug: "string?", externalId: "string|null?", parentId: "string|null?", metadata: "object?", settings: "object?", expectedVersion: "number?" },
  archiveTeam: { teamId: "string", reason: "string?", expectedVersion: "number?" },
  restoreTeam: { teamId: "string", expectedVersion: "number?" },
  deleteTeam: { teamId: "string" },
  addMember: { id: "string?", teamId: "string", membershipId: "string", status: "pendingOrActive?", responsibility: "responsibility?", roleIds: "strings?" },
  acceptInvitation: { teamMembershipId: "string" },
  leaveTeam: { teamId: "string" },
  removeMember: { teamMembershipId: "string", reason: "string?" },
  suspendMember: { teamMembershipId: "string", reason: "string?" },
  reactivateMember: { teamMembershipId: "string" },
  setResponsibility: { teamMembershipId: "string", responsibility: "responsibility" },
  assignRole: { teamMembershipId: "string", roleId: "string" },
  unassignRole: { teamMembershipId: "string", roleId: "string" },
  moveMember: { id: "string?", membershipId: "string", fromTeamId: "string", toTeamId: "string", reason: "string?" },
};

const bad = (message: string) => new TeamError(message, "team_invalid");

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
    case "object":
      if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
      break;
    case "strings":
      if (Array.isArray(value) && value.length <= 50 && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 2000)) return [...value];
      break;
    case "responsibility":
      if (value === "owner" || value === "manager" || value === "member") return value as TeamResponsibility;
      break;
    case "pendingOrActive":
      if (value === "pending" || value === "active") return value;
      break;
  }
  throw bad(`"${name}" is not valid.`);
}

/** Keeps only what the command declares and checks each field; an unknown field is an error, never silently passed on. */
function clean(command: TeamCommand, params: unknown): Record<string, unknown> {
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
 * Validates `params` and runs the command on the team service as `context.actor`, returning a JSON-safe result (dates as
 * ISO strings). Authorization is the service's: this function adds input checking and a fixed door, not permissions.
 * Failures are `TeamError`s; `teamErrorToHttp` turns them into responses.
 */
export async function runTeamCommand(service: TeamService, command: string, context: TeamCommandContext, params: unknown): Promise<unknown> {
  if (!isTeamCommand(command)) throw bad(`Unknown team command "${String(command)}".`);
  const input = clean(command, params);
  const who = { actor: context.actor, organizationId: context.organizationId };
  const id = () => (typeof input.id === "string" ? input.id : crypto.randomUUID());
  let result: unknown;
  switch (command) {
    case "createTeam":
      result = await service.createTeam({ ...who, ...(input as object), id: id() } as Parameters<TeamService["createTeam"]>[0]);
      break;
    case "updateTeam":
      result = await service.updateTeam({ ...who, ...(input as object) } as Parameters<TeamService["updateTeam"]>[0]);
      break;
    case "archiveTeam":
      result = await service.archiveTeam({ ...who, ...(input as object) } as Parameters<TeamService["archiveTeam"]>[0]);
      break;
    case "restoreTeam":
      result = await service.restoreTeam({ ...who, ...(input as object) } as Parameters<TeamService["restoreTeam"]>[0]);
      break;
    case "deleteTeam":
      await service.deleteTeam({ ...who, teamId: input.teamId as string });
      result = { deleted: true };
      break;
    case "addMember":
      result = await service.addMember({ ...who, ...(input as object), id: id() } as Parameters<TeamService["addMember"]>[0]);
      break;
    case "acceptInvitation":
      result = await service.acceptInvitation({ ...who, teamMembershipId: input.teamMembershipId as string });
      break;
    case "leaveTeam":
      result = await service.leaveTeam({ ...who, teamId: input.teamId as string });
      break;
    case "removeMember":
      result = await service.removeMember({ ...who, ...(input as object) } as Parameters<TeamService["removeMember"]>[0]);
      break;
    case "suspendMember":
      result = await service.suspendMember({ ...who, ...(input as object) } as Parameters<TeamService["suspendMember"]>[0]);
      break;
    case "reactivateMember":
      result = await service.reactivateMember({ ...who, teamMembershipId: input.teamMembershipId as string });
      break;
    case "setResponsibility":
      result = await service.setResponsibility({ ...who, ...(input as object) } as Parameters<TeamService["setResponsibility"]>[0]);
      break;
    case "assignRole":
      result = await service.assignRole({ ...who, ...(input as object) } as Parameters<TeamService["assignRole"]>[0]);
      break;
    case "unassignRole":
      result = await service.unassignRole({ ...who, ...(input as object) } as Parameters<TeamService["unassignRole"]>[0]);
      break;
    case "moveMember":
      result = await service.moveMember({ ...who, ...(input as object), id: id() } as Parameters<TeamService["moveMember"]>[0]);
      break;
  }
  return JSON.parse(JSON.stringify(result));
}

export interface TeamHttpError {
  status: 400 | 401 | 403 | 404 | 409 | 500;
  body: { error: string; message: string };
}

const CONFLICT = new Set(["team_exists", "team_slug_taken", "team_external_id_taken", "team_membership_exists", "team_version_conflict", "team_membership_version_conflict", "team_has_children", "team_not_archived", "team_archived", "team_membership_transition_invalid"]);
const NOT_FOUND = new Set(["team_not_found", "team_membership_not_found", "team_member_unknown", "team_organization_unknown"]);

/**
 * Maps a `TeamError` to the response a route should send, or `null` for anything else (a bug or an outage: let it
 * propagate). A refusal never says why beyond "forbidden", so the answer can't be used to probe teams you may not see.
 */
export function teamErrorToHttp(error: unknown): TeamHttpError | null {
  if (!(error instanceof TeamError)) return null;
  const code = error.code;
  if (code === "team_forbidden" || code === "team_accept_forbidden") {
    return { status: 403, body: { error: "forbidden", message: "You are not allowed to do that." } };
  }
  if (code === "team_authorization_required") {
    // The storage refused a write the service should have authorized: a programming error, not the caller's.
    return { status: 500, body: { error: "internal_error", message: "Something went wrong." } };
  }
  if (NOT_FOUND.has(code)) return { status: 404, body: { error: code, message: error.message } };
  if (CONFLICT.has(code)) return { status: 409, body: { error: code, message: error.message } };
  return { status: 400, body: { error: code, message: error.message } };
}
