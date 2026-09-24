"use server";

import type { UnioraTransaction } from "@uniora/core";
import { StudioError } from "@/lib/validate";
import { audit, mutateInOrg, newId, text, textList, type ActionResult } from "@/actions/mutate";

const orgPaths = (organizationId: string) => [`/organizations/${organizationId}`, "/organizations", "/permissions", "/"];

export interface CreateRoleArgs {
  organizationId: string;
  name: string;
  key?: string;
  permissionKeys?: string[];
}

export async function createRole(args: CreateRoleArgs): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const role = await tx.roles.create({
      id: newId(),
      organizationId,
      name: text(args.name, "field.roleName", { max: 100 }),
      key: text(args.key, "field.roleKey", { max: 63, optional: true }),
      permissionKeys: textList(args.permissionKeys, "field.permissions"),
    });
    await audit(tx, organizationId, "role.created", { type: "role", id: role.id }, {
      name: role.name,
      key: role.key,
      permissions: role.permissionKeys,
    });
  });
}

async function loadRole(tx: UnioraTransaction, roleId: string) {
  // Light summary: renaming/deleting/granting must not load the role's whole permission list.
  const [role] = await tx.roles.findSummariesByIds([roleId]);
  if (!role) throw new StudioError("errors.roleGone");
  return role;
}

export async function renameRole(args: { organizationId: string; roleId: string; name: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const role = await loadRole(tx, text(args.roleId, "field.role", { max: 128 }));
    if (role.organizationId !== organizationId) throw new StudioError("errors.roleOtherOrg");
    const renamed = await tx.roles.rename(role.id, text(args.name, "field.roleName", { max: 100 }));
    await audit(tx, organizationId, "role.renamed", { type: "role", id: role.id }, { from: role.name, to: renamed.name });
  });
}

export async function deleteRole(args: { organizationId: string; roleId: string }): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const role = await loadRole(tx, text(args.roleId, "field.role", { max: 128 }));
    if (role.organizationId !== organizationId) throw new StudioError("errors.roleOtherOrg");
    await tx.roles.delete(role.id);
    await audit(tx, organizationId, "role.deleted", { type: "role", id: role.id }, { name: role.name, key: role.key });
  });
}

export async function setRolePermission(args: {
  organizationId: string;
  roleId: string;
  permissionKey: string;
  granted: boolean;
}): Promise<ActionResult> {
  return mutateInOrg(args?.organizationId, orgPaths, async (tx, organizationId) => {
    const role = await loadRole(tx, text(args.roleId, "field.role", { max: 128 }));
    if (role.organizationId !== organizationId) throw new StudioError("errors.roleOtherOrg");
    const permissionKey = text(args.permissionKey, "field.permission", { max: 128 });
    if (args.granted === true) {
      await tx.roles.grantPermission(role.id, permissionKey);
    } else {
      await tx.roles.revokePermission(role.id, permissionKey);
    }
    await audit(
      tx,
      organizationId,
      args.granted === true ? "role.permission_granted" : "role.permission_revoked",
      { type: "role", id: role.id },
      { role: role.name, permission: permissionKey },
    );
  });
}
