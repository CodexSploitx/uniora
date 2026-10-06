import { randomId } from "../invitation/token.js";
import type { RoleRepository } from "./repository.js";
import type { Role } from "./types.js";

/** A role your code defines once and every organization gets: e.g. "Receptionist" with its permissions. */
export interface RoleTemplate {
  /** The role's `key` in every organization (unique per organization; `owner` is reserved). */
  key: string;
  name: string;
  description?: string;
  permissionKeys: string[];
}

export interface ApplyRoleTemplatesOptions {
  /** Id for a role that has to be created. Defaults to a random one. */
  newId?: (template: RoleTemplate) => string;
}

export interface ApplyRoleTemplatesResult {
  /** Roles that did not exist and were created (as system roles). */
  created: Role[];
  /** System roles that already existed and were brought back in line with the template (permissions, description). */
  synced: Role[];
  /** Keys whose role already exists but is a role a tenant made (not a system role): left untouched. */
  skipped: string[];
}

/**
 * Gives an organization the system roles your templates describe. Idempotent, so it can run when an organization is
 * created and again on every deploy to roll a change of a template out to all of them: a missing role is created
 * (`isSystem: true`), an existing system role has its permission list replaced atomically (`setPermissions`) and
 * its description updated, and a custom role a tenant created under the same key is never touched.
 *
 * Calls repositories directly: wrap them with `createAuditedStorage` (or run it inside `storage.transaction`) to get
 * the audit entries. Authorization is the caller's job.
 */
export async function applyRoleTemplates(
  roles: Pick<RoleRepository, "create" | "listByOrganization" | "setPermissions" | "update">,
  organizationId: string,
  templates: readonly RoleTemplate[],
  options: ApplyRoleTemplatesOptions = {},
): Promise<ApplyRoleTemplatesResult> {
  const existing = new Map((await roles.listByOrganization(organizationId)).map((role) => [role.key, role]));
  const result: ApplyRoleTemplatesResult = { created: [], synced: [], skipped: [] };
  for (const template of templates) {
    const current = existing.get(template.key);
    if (!current) {
      result.created.push(
        await roles.create({
          id: options.newId?.(template) ?? `role-${randomId()}`,
          organizationId,
          name: template.name,
          key: template.key,
          permissionKeys: template.permissionKeys,
          ...(template.description !== undefined ? { description: template.description } : {}),
          isSystem: true,
        }),
      );
    } else if (current.isSystem) {
      await roles.setPermissions(current.id, template.permissionKeys);
      const synced =
        (current.description ?? undefined) === template.description
          ? current
          : await roles.update(current.id, { description: template.description ?? null });
      result.synced.push({ ...synced, permissionKeys: [...new Set(template.permissionKeys)] });
    } else {
      result.skipped.push(template.key);
    }
  }
  return result;
}
