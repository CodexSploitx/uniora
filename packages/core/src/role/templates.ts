import { randomId } from "../invitation/token.js";
import { normalizeRoleName } from "./key.js";
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
  /**
   * `"sync"` (default, as before): create what is missing AND bring existing system roles back in line with the
   * template (permission list replaced, description updated), which overwrites what an Owner edited.
   * `"create-missing"`: only create what is missing; an existing role is never changed, whoever made it. Use it
   * to give a new organization its roles, or to add a new template without touching the ones already handed out.
   */
  mode?: "sync" | "create-missing";
  /**
   * `false` (default): the first unexpected error is thrown (what the roles repository throws, e.g. an unregistered
   * permission key). `true`: that template is recorded in `failed` and the rest are still applied. Not for use
   * inside a PostgreSQL transaction (a failed statement aborts the whole transaction): call it on the plain
   * repositories, where each template is its own statement. A key or name that is already taken never counts as an
   * error: it goes to `conflicts` in both settings.
   */
  continueOnError?: boolean;
}

/** A template that could not be created because the organization already has a role with that key or name. */
export interface RoleTemplateConflict {
  key: string;
  /** `key_taken`: a role the tenant made already uses the key. `name_taken`: another role already has that name. */
  reason: "key_taken" | "name_taken";
}

export interface RoleTemplateFailure {
  key: string;
  error: unknown;
}

export interface ApplyRoleTemplatesResult {
  /** Roles that did not exist and were created (as system roles). */
  created: Role[];
  /** System roles that already existed and were brought back in line with the template (permissions, description). */
  synced: Role[];
  /** Keys whose role already exists but is a role a tenant made (not a system role): left untouched. */
  skipped: string[];
  /** `mode: "create-missing"` only: keys whose system role already exists and was left exactly as it is. */
  unchanged: string[];
  /** Templates not created because the key (a role of a tenant) or the name is already used; the rest were still applied. */
  conflicts: RoleTemplateConflict[];
  /** `continueOnError: true` only: templates that failed, with the error. */
  failed: RoleTemplateFailure[];
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
  const names = new Set([...existing.values()].map((role) => normalizeRoleName(role.name)));
  const createOnly = options.mode === "create-missing";
  const result: ApplyRoleTemplatesResult = { created: [], synced: [], skipped: [], unchanged: [], conflicts: [], failed: [] };
  for (const template of templates) {
    try {
      const current = existing.get(template.key);
      if (!current) {
        // A name a tenant's role already uses would make `create` throw and, before, stop every template after this one.
        if (names.has(normalizeRoleName(template.name))) {
          result.conflicts.push({ key: template.key, reason: "name_taken" });
          continue;
        }
        const created = await roles.create({
          id: options.newId?.(template) ?? `role-${randomId()}`,
          organizationId,
          name: template.name,
          key: template.key,
          permissionKeys: template.permissionKeys,
          ...(template.description !== undefined ? { description: template.description } : {}),
          isSystem: true,
        });
        result.created.push(created);
        existing.set(created.key, created);
        names.add(normalizeRoleName(created.name));
      } else if (!current.isSystem) {
        result.skipped.push(template.key);
        result.conflicts.push({ key: template.key, reason: "key_taken" });
      } else if (createOnly) {
        result.unchanged.push(template.key);
      } else {
        await roles.setPermissions(current.id, template.permissionKeys);
        const synced =
          (current.description ?? undefined) === template.description
            ? current
            : await roles.update(current.id, { description: template.description ?? null });
        result.synced.push({ ...synced, permissionKeys: [...new Set(template.permissionKeys)] });
      }
    } catch (error) {
      if (!options.continueOnError) throw error;
      result.failed.push({ key: template.key, error });
    }
  }
  return result;
}
