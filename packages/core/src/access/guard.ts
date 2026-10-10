import type { Identity } from "../identity/types.js";
import type { UnioraStorage, UnioraTransaction } from "../storage/types.js";
import { AccessError } from "./errors.js";
import { accessSet, assertAccessAuthorization, issueAccessAuthorization } from "./authorization.js";
import type { AccessBinding } from "./authorization.js";

type Repo = "memberships" | "roles" | "invitations";

interface GuardedWrite {
  repo: Repo;
  method: string;
  /** Index of the argument that carries `authorization` (an options bag, or the input itself). */
  slot: number;
  /** What the token must be bound to, or `null` when this particular call does not change anyone's power. */
  bind(args: unknown[]): AccessBinding | null;
  /** The actor the call names, when it names one. */
  actor?(args: unknown[]): Identity | undefined;
}

const text = (value: unknown): string => String(value);
const input = (args: unknown[], index: number): Record<string, unknown> => (args[index] ?? {}) as Record<string, unknown>;
const actorOf = (index: number) => (args: unknown[]): Identity | undefined => input(args, index).actor as Identity | undefined;

/** How `roles.delete` treats the members that hold the role, as the text a token is bound to. */
function deleteMode(options: Record<string, unknown>): string {
  const members = options.members;
  if (members === undefined || members === "detach") return "detach";
  if (members === "reject") return "reject";
  return `reassign:${text((members as { reassignTo?: unknown }).reassignTo)}`;
}

/**
 * Every write that decides who holds which power, and what a token for it is bound to. The guard, the trusted wrapper and the
 * audited wrapper all work from this one table, so they cannot disagree about what is guarded.
 */
const GUARDED: readonly GuardedWrite[] = [
  {
    repo: "memberships",
    method: "create",
    slot: 0,
    // A member without roles holds no power; the roles it is created with are a grant like any other.
    bind: (a) => {
      const roleIds = input(a, 0).roleIds as string[] | undefined;
      if (!roleIds || roleIds.length === 0) return null;
      return { operation: "member.create", target: text(input(a, 0).id), detail: accessSet(roleIds), organizationId: text(input(a, 0).organizationId) };
    },
  },
  { repo: "memberships", method: "assignRole", slot: 2, bind: (a) => ({ operation: "member.role.assign", target: text(a[0]), detail: text(a[1]) }) },
  { repo: "memberships", method: "unassignRole", slot: 2, bind: (a) => ({ operation: "member.role.unassign", target: text(a[0]), detail: text(a[1]) }) },
  { repo: "memberships", method: "assignOwnerRole", slot: 2, bind: (a) => ({ operation: "member.owner", target: text(a[0]), detail: `assign:${text(a[1])}` }) },
  { repo: "memberships", method: "unassignOwnerRole", slot: 2, bind: (a) => ({ operation: "member.owner", target: text(a[0]), detail: `unassign:${text(a[1])}` }) },
  { repo: "memberships", method: "block", slot: 1, bind: (a) => ({ operation: "member.status", target: text(a[0]), detail: "block" }), actor: actorOf(1) },
  { repo: "memberships", method: "suspend", slot: 1, bind: (a) => ({ operation: "member.status", target: text(a[0]), detail: "suspend" }), actor: actorOf(1) },
  { repo: "memberships", method: "unblock", slot: 1, bind: (a) => ({ operation: "member.status", target: text(a[0]), detail: "unblock" }), actor: actorOf(1) },
  { repo: "memberships", method: "delete", slot: 1, bind: (a) => ({ operation: "member.delete", target: text(a[0]) }) },
  {
    repo: "roles",
    method: "create",
    slot: 0,
    bind: (a) => ({ operation: "role.create", target: text(input(a, 0).id), detail: accessSet(input(a, 0).permissionKeys as string[] | undefined), organizationId: text(input(a, 0).organizationId) }),
  },
  {
    repo: "roles",
    method: "clone",
    slot: 1,
    bind: (a) => ({
      operation: "role.create",
      target: text(input(a, 1).id),
      detail: `clone:${text(a[0])}`,
      ...(typeof input(a, 1).organizationId === "string" ? { organizationId: input(a, 1).organizationId as string } : {}),
    }),
  },
  { repo: "roles", method: "rename", slot: 2, bind: (a) => ({ operation: "role.edit", target: text(a[0]), detail: "rename" }) },
  { repo: "roles", method: "update", slot: 1, bind: (a) => ({ operation: "role.edit", target: text(a[0]), detail: "update" }) },
  { repo: "roles", method: "grantPermission", slot: 2, bind: (a) => ({ operation: "role.permissions", target: text(a[0]), detail: `grant:${text(a[1])}` }) },
  { repo: "roles", method: "revokePermission", slot: 2, bind: (a) => ({ operation: "role.permissions", target: text(a[0]), detail: `revoke:${text(a[1])}` }) },
  { repo: "roles", method: "setPermissions", slot: 2, bind: (a) => ({ operation: "role.permissions", target: text(a[0]), detail: `set:${accessSet(a[1] as string[])}` }) },
  { repo: "roles", method: "delete", slot: 1, bind: (a) => ({ operation: "role.delete", target: text(a[0]), detail: deleteMode(input(a, 1)) }) },
  {
    repo: "invitations",
    method: "create",
    slot: 0,
    bind: (a) => ({ operation: "invitation.create", target: text(input(a, 0).id), detail: accessSet(input(a, 0).roleIds as string[] | undefined), organizationId: text(input(a, 0).organizationId) }),
  },
  { repo: "invitations", method: "rotateToken", slot: 1, bind: (a) => ({ operation: "invitation.manage", target: text(a[0]), detail: "rotate" }) },
  { repo: "invitations", method: "revoke", slot: 2, bind: (a) => ({ operation: "invitation.manage", target: text(a[0]), detail: "revoke" }) },
];

/** The writes the guard covers, as `repository.method`, for documentation and tests. */
export const GUARDED_WRITES: readonly string[] = GUARDED.map((write) => `${write.repo}.${write.method}`);

type AnyFn = (...args: unknown[]) => unknown;
export type AnyRepo = Record<string, AnyFn>;

/**
 * A plain copy of a repository whose methods keep working when the repository is a class instance (its methods live on the
 * prototype, where a spread does not reach) or relies on `this`: every method found along the prototype chain is bound to the
 * original. A custom backend written as classes therefore works under the guard like one written as object literals.
 */
export function plainRepo(repo: AnyRepo): AnyRepo {
  const copy: AnyRepo = {};
  for (let object: object | null = repo; object !== null && object !== Object.prototype; object = Object.getPrototypeOf(object)) {
    for (const key of Object.getOwnPropertyNames(object)) {
      if (key === "constructor" || Object.hasOwn(copy, key)) continue;
      const value = (repo as Record<string, unknown>)[key];
      copy[key] = typeof value === "function" ? (value as AnyFn).bind(repo) : (value as AnyFn);
    }
  }
  return copy;
}

/** The argument bag with the token taken out, or `undefined` when nothing else was in it. */
function withoutToken(value: unknown): { token: unknown; rest: unknown } {
  if (typeof value !== "object" || value === null) return { token: undefined, rest: value };
  const { authorization, ...rest } = value as Record<string, unknown>;
  return { token: authorization, rest };
}

const GUARDED_MARK = Symbol.for("uniora.access-guard");

/** Whether `storage` (or a transaction of it) is wrapped by `createGuardedStorage`. */
export function isGuardedStorage(storage: unknown): boolean {
  return typeof storage === "object" && storage !== null && (storage as Record<symbol, unknown>)[GUARDED_MARK] === true;
}

function guardRepo(repo: AnyRepo, name: Repo): AnyRepo {
  const wrapped = plainRepo(repo);
  for (const write of GUARDED.filter((entry) => entry.repo === name)) {
    const original = repo[write.method];
    if (typeof original !== "function") continue;
    wrapped[write.method] = function (this: unknown, ...args: unknown[]) {
      const binding = write.bind(args);
      const { token, rest } = withoutToken(args[write.slot]);
      if (binding !== null) {
        const actor = write.actor?.(args);
        try {
          assertAccessAuthorization(token, { ...binding, ...(actor ? { actor } : {}) });
        } catch (error) {
          return Promise.reject(error);
        }
      }
      const next = [...args];
      // The backend never sees the token: what it does not know it cannot misuse, and an empty bag is simply no bag.
      if (typeof args[write.slot] === "object" && args[write.slot] !== null) next[write.slot] = rest;
      return original.apply(repo, next);
    };
  }
  return wrapped;
}

function guardScope<T extends UnioraStorage | UnioraTransaction>(scope: T): T {
  return {
    ...plainRepo(scope as unknown as AnyRepo),
    memberships: guardRepo(scope.memberships as unknown as AnyRepo, "memberships"),
    roles: guardRepo(scope.roles as unknown as AnyRepo, "roles"),
    invitations: guardRepo(scope.invitations as unknown as AnyRepo, "invitations"),
    [GUARDED_MARK]: true,
  } as unknown as T;
}

/**
 * Wraps a storage so that every write which decides who holds which power refuses to run without an `AccessAuthorization`:
 * giving or taking a role (`memberships.assignRole`, `unassignRole`, `assignOwnerRole`, `unassignOwnerRole`, `create` with roles),
 * blocking, suspending, unblocking or deleting a member, creating, editing, cloning or deleting a role or changing its permissions,
 * and creating, resending or revoking an invitation. Reads and every other write pass through untouched.
 *
 * Build it ONCE, around the storage of your backend, and hand only the wrapped object to the rest of your code
 * (`const storage = createGuardedStorage(createPostgresStorage(...))`): whoever holds the plain storage can still write
 * freely, exactly as before. With the wrapper, the only ways to change power are the access service and the invitation service
 * (which check the rules and issue the token), the library's own founding flows, and `createTrustedAccessStorage` (named,
 * greppable back-office code). It works over any `UnioraStorage`, so a custom backend gets it for free.
 */
export function createGuardedStorage(storage: UnioraStorage): UnioraStorage {
  if (isGuardedStorage(storage)) return storage;
  const guarded = guardScope(storage);
  return {
    ...guarded,
    transaction: <T>(callback: (tx: UnioraTransaction) => Promise<T>) => storage.transaction((tx) => callback(guardScope(tx))),
  } as UnioraStorage;
}

export interface TrustedAccessStorageOptions {
  /** Who is making the changes (recorded in the audit log when the storage is audited). */
  actor: Identity;
  /** Why this code is allowed to skip the rules: "bulk import from the old CRM", "role templates at start-up". Required. */
  reason: string;
}

/**
 * Back-office access to a guarded storage WITHOUT the rules: for imports, migrations, seeding role templates
 * (`applyRoleTemplates`), ownership transfers (`transferOwnership`), admin tooling and tests that run as the system, never in a
 * request handler that serves end users (use `createAccessAdminService` there). Every guarded write is stamped with a trusted
 * token for exactly that operation and target, so the guard accepts it; nothing else about the storage changes (isolation,
 * validation, versions). Wrap an audited storage with it (`createTrustedAccessStorage(createAuditedStorage(guarded, { actor }), ...)`)
 * to keep the audit trail.
 *
 * It is named and documented to be greppable: any use of it in code that answers a user request is a bug in review.
 */
export function createTrustedAccessStorage(storage: UnioraStorage, options: TrustedAccessStorageOptions): UnioraStorage {
  if (typeof options?.reason !== "string" || options.reason.trim() === "") {
    throw new AccessError("A trusted access storage needs a reason saying why it skips the access rules.", "access_invalid");
  }
  const { actor } = options;

  function stampRepo(repo: AnyRepo, name: Repo): AnyRepo {
    const wrapped = plainRepo(repo);
    for (const write of GUARDED.filter((entry) => entry.repo === name)) {
      const original = repo[write.method];
      if (typeof original !== "function") continue;
      wrapped[write.method] = function (this: unknown, ...args: unknown[]) {
        const binding = write.bind(args);
        if (binding === null) return original.apply(repo, args);
        const next = [...args];
        const bag = typeof next[write.slot] === "object" && next[write.slot] !== null ? (next[write.slot] as Record<string, unknown>) : {};
        next[write.slot] = { ...bag, authorization: issueAccessAuthorization(actor, binding, { trusted: true }) };
        return original.apply(repo, next);
      };
    }
    return wrapped;
  }

  function stamp<T extends UnioraStorage | UnioraTransaction>(scope: T): T {
    return {
      ...plainRepo(scope as unknown as AnyRepo),
      memberships: stampRepo(scope.memberships as unknown as AnyRepo, "memberships"),
      roles: stampRepo(scope.roles as unknown as AnyRepo, "roles"),
      invitations: stampRepo(scope.invitations as unknown as AnyRepo, "invitations"),
    } as unknown as T;
  }

  return {
    ...stamp(storage),
    transaction: <T>(callback: (tx: UnioraTransaction) => Promise<T>) => storage.transaction((tx) => callback(stamp(tx))),
  } as UnioraStorage;
}
