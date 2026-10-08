import type { Identity } from "../identity/types.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import { issueTeamAuthorization } from "./authorization.js";
import type { TeamAuthorization, TeamOperation } from "./authorization.js";
import { TeamError } from "./repository.js";
import type { TeamMembershipRepository, TeamRepository } from "./repository.js";

/** Drops `authorization` from the last parameter; when nothing else in it is required, the parameter becomes optional. */
type StripAuthorization<A extends unknown[]> = A extends [...infer Head, infer Last]
  ? Last extends { authorization: TeamAuthorization }
    ? {} extends Omit<Last, "authorization">
      ? [...Head, Omit<Last, "authorization">?]
      : [...Head, Omit<Last, "authorization">]
    : A
  : A;
type Trusted<R> = {
  [K in keyof R]: R[K] extends (...args: infer A) => infer Ret ? (...args: StripAuthorization<A>) => Ret : R[K];
};

/** `storage.teams` / `storage.teamMemberships` with the authorization filled in by the trusted wrapper. */
export type TrustedTeamStorage = Omit<UnioraStorage, "teams" | "teamMemberships" | "transaction"> & {
  teams: Trusted<TeamRepository>;
  teamMemberships: Trusted<TeamMembershipRepository>;
  transaction<T>(callback: (tx: TrustedTeamTransaction) => Promise<T>): Promise<T>;
};
export type TrustedTeamTransaction = Omit<UnioraTransaction, "teams" | "teamMemberships"> & {
  teams: Trusted<TeamRepository>;
  teamMemberships: Trusted<TeamMembershipRepository>;
};

export interface TrustedTeamStorageOptions {
  /** Who is making the changes (recorded in the audit log when the storage is audited). */
  actor: Identity;
  /** Why this code is allowed to skip the permission check: "bulk import from the old CRM", "nightly sync job". Required. */
  reason: string;
}

/**
 * Back-office access to the team repositories WITHOUT a permission check: for imports, migrations, sync jobs, tests and
 * admin tooling that run as the system, never in a request handler that serves end users (use `createTeamService` there).
 * Every write is stamped with an authorization issued for exactly that organization and operation, so the storage accepts it;
 * nothing else about the rules changes (isolation, lifecycle, validation, versions). Wrap an audited storage with it
 * (`createTrustedTeamStorage(createAuditedStorage(storage, { actor }), ...)`) to keep the audit trail.
 *
 * It is named and documented to be greppable: any use of it in code that answers a user request is a bug in review.
 */
export function createTrustedTeamStorage(storage: UnioraStorage, options: TrustedTeamStorageOptions): TrustedTeamStorage {
  if (typeof options?.reason !== "string" || options.reason.trim() === "") {
    throw new TeamError("A trusted team storage needs a reason saying why it skips the permission check.", "team_invalid");
  }
  const { actor } = options;
  const token = (organizationId: string, operation: TeamOperation): TeamAuthorization =>
    issueTeamAuthorization(organizationId, actor, [operation], { trusted: true });

  function wrap(scope: UnioraStorage | UnioraTransaction) {
    const { teams, teamMemberships } = scope;
    return {
      teams: {
        ...teams,
        create: (input: Parameters<TeamRepository["create"]>[0] extends infer I ? Omit<I & object, "authorization"> : never) =>
          teams.create({ ...input, authorization: token((input as { organizationId: string }).organizationId, "team.create") }),
        update: (organizationId: string, id: string, input: object) =>
          teams.update(organizationId, id, { ...input, authorization: token(organizationId, "team.update") }),
        archive: (organizationId: string, id: string, input: { actor: Identity }) =>
          teams.archive(organizationId, id, { ...input, authorization: token(organizationId, "team.archive") }),
        restore: (organizationId: string, id: string, input: { actor: Identity }) =>
          teams.restore(organizationId, id, { ...input, authorization: token(organizationId, "team.restore") }),
        delete: (organizationId: string, id: string) => teams.delete(organizationId, id, { authorization: token(organizationId, "team.delete") }),
      },
      teamMemberships: {
        ...teamMemberships,
        add: (input: Omit<Parameters<TeamMembershipRepository["add"]>[0], "authorization">) =>
          teamMemberships.add({ ...input, authorization: token(input.organizationId, "member.add") }),
        setStatus: (organizationId: string, id: string, status: never, input: { actor: Identity }) =>
          teamMemberships.setStatus(organizationId, id, status, { ...input, authorization: token(organizationId, "member.status") }),
        accept: (organizationId: string, id: string, input: { actor: Identity }) =>
          teamMemberships.accept(organizationId, id, { ...input, authorization: token(organizationId, "member.accept") }),
        setResponsibility: (organizationId: string, id: string, responsibility: never, extra: object = {}) =>
          teamMemberships.setResponsibility(organizationId, id, responsibility, { ...extra, authorization: token(organizationId, "member.responsibility") }),
        assignRole: (organizationId: string, id: string, roleId: string, extra: object = {}) =>
          teamMemberships.assignRole(organizationId, id, roleId, { ...extra, authorization: token(organizationId, "member.role") }),
        unassignRole: (organizationId: string, id: string, roleId: string, extra: object = {}) =>
          teamMemberships.unassignRole(organizationId, id, roleId, { ...extra, authorization: token(organizationId, "member.role") }),
      },
    };
  }

  const top = wrap(storage);
  return {
    ...storage,
    ...top,
    transaction: (callback: (tx: TrustedTeamTransaction) => Promise<never>) =>
      storage.transaction((tx) => callback({ ...tx, ...wrap(tx) } as unknown as TrustedTeamTransaction)),
  } as unknown as TrustedTeamStorage;
}
