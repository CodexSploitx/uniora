import type { Identity } from "../identity/types.js";
import { issuePlatformAuthorization } from "./authorization.js";
import { PlatformError } from "./errors.js";
import { PLATFORM_ALL } from "./permissions.js";
import { PLATFORM_LOCK_KEY, assertPlatformIdentity } from "./repository.js";
import type { PlatformStorage } from "./repository.js";
import { PLATFORM_ADMIN_ROLE_KEY } from "./types.js";
import type { PlatformMember, PlatformRole } from "./types.js";

export interface BootstrapPlatformInput {
  platform: PlatformStorage;
  /** The first Platform Administrator. */
  admin: Identity;
  /** Who is running the bootstrap, recorded in the audit log (for example `{ provider: "cli", subject: "alice@host" }`). Defaults to `admin`. */
  actor?: Identity;
}

export interface BootstrapPlatformResult {
  role: PlatformRole;
  member: PlatformMember;
}

/**
 * Creates the system role `platform_admin` (every platform permission) and its first member. It works exactly once: as soon
 * as the platform has any member it refuses (`platform_already_initialized`), so it cannot be used later to take over.
 * Running it needs direct access to the platform database, which is the root of trust: whoever has that can already do
 * anything. There is no way to call it through an organization, a request handler or the platform service.
 */
export async function bootstrapPlatform(input: BootstrapPlatformInput): Promise<BootstrapPlatformResult> {
  assertPlatformIdentity(input.admin, "first administrator");
  const actor = input.actor ?? input.admin;
  assertPlatformIdentity(actor, "actor");
  return input.platform.transaction(async (tx) => {
    await tx.lock?.(PLATFORM_LOCK_KEY);
    if ((await tx.platformMembers.count()) > 0) {
      throw new PlatformError("The platform is already initialised; add administrators from the platform service.", "platform_already_initialized");
    }
    const authorization = issuePlatformAuthorization(actor, ["bootstrap", "member.add"], { trusted: true });
    const existing = await tx.platformRoles.findByKey(PLATFORM_ADMIN_ROLE_KEY);
    if (existing && !existing.isSystem) {
      throw new PlatformError(`A role with the reserved key "${PLATFORM_ADMIN_ROLE_KEY}" exists but is not a system role.`, "platform_role_exists");
    }
    const role =
      existing ??
      (await tx.platformRoles.create({
        id: crypto.randomUUID(),
        key: PLATFORM_ADMIN_ROLE_KEY,
        name: "Platform Administrator",
        description: "Full control of the platform. Held by the people who administer the whole project, never by organization roles.",
        permissions: [PLATFORM_ALL],
        isSystem: true,
        authorization,
      }));
    const member = await tx.platformMembers.add({ id: crypto.randomUUID(), identity: input.admin, roleIds: [role.id], addedBy: actor, authorization });
    await tx.auditLogs.record({
      id: crypto.randomUUID(),
      actor,
      action: "platform.bootstrapped",
      target: { type: "platform_member", id: member.id },
      metadata: { admin: `${input.admin.provider}:${input.admin.subject}` },
    });
    return { role, member };
  });
}
