"use server";

import { audit, mutate, text, type ActionResult } from "@/actions/mutate";

export async function registerPermission(args: { key: string; name?: string; description?: string }): Promise<ActionResult> {
  return mutate(["/permissions"], async (tx) => {
    const key = text(args?.key, "field.permissionKey", { max: 128 });
    await tx.permissions.register({
      key,
      name: text(args?.name, "field.name", { max: 100, optional: true }),
      description: text(args?.description, "field.description", { max: 500, optional: true }),
    });
    // The catalog defines what can be granted at all, so changing it is audited (global entry).
    await audit(tx, undefined, "permission.registered", { type: "permission", id: key });
  });
}

export async function unregisterPermission(args: { key: string }): Promise<ActionResult> {
  return mutate(["/permissions"], async (tx) => {
    const key = text(args?.key, "field.permission", { max: 128 });
    await tx.permissions.unregister(key);
    await audit(tx, undefined, "permission.unregistered", { type: "permission", id: key });
  });
}
