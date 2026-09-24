"use server";

import { mutate, text, type ActionResult } from "@/actions/mutate";

export async function registerPermission(args: { key: string; name?: string; description?: string }): Promise<ActionResult> {
  return mutate(["/permissions"], async (tx) => {
    await tx.permissions.register({
      key: text(args?.key, "field.permissionKey", { max: 128 }),
      name: text(args?.name, "field.name", { max: 100, optional: true }),
      description: text(args?.description, "field.description", { max: 500, optional: true }),
    });
  });
}

export async function unregisterPermission(args: { key: string }): Promise<ActionResult> {
  return mutate(["/permissions"], async (tx) => {
    await tx.permissions.unregister(text(args?.key, "field.permission", { max: 128 }));
  });
}
