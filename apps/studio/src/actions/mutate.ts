import "server-only";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  FeatureError,
  IdentityLinkError,
  MembershipError,
  OrganizationError,
  PermissionError,
  RoleError,
  type Identity,
  type UnioraTransaction,
} from "@uniora/core";
import { getStorage } from "@/lib/db";
import { StudioAuthError, StudioReadOnlyError, requireWrite } from "@/lib/session";
import { getT } from "@/i18n/server";
import { InputError, StudioError, text } from "@/lib/validate";

export type ActionResult<T = undefined> = ({ ok: true } & (T extends undefined ? object : { data: T })) | { ok: false; error: string };

/** Who audit entries created from Studio are attributed to. */
export const STUDIO_ACTOR: Identity = { provider: "uniora-studio", subject: "local-admin" };

export { InputError, StudioError, text, textList } from "@/lib/validate";

export function newId(): string {
  return randomUUID();
}

export async function audit(
  tx: UnioraTransaction,
  organizationId: string,
  action: string,
  target?: { type: string; id: string },
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.auditLogs.record({ id: newId(), organizationId, actor: STUDIO_ACTOR, action, target, metadata });
}

const DOMAIN_ERRORS = [FeatureError, IdentityLinkError, MembershipError, OrganizationError, PermissionError, RoleError];

/** Studio's own failures are translated to the viewer's language; Core's domain errors are shown verbatim (Core has no i18n). */
async function describeError(error: unknown): Promise<string> {
  const { t } = await getT();
  if (error instanceof InputError) return t(`errors.${error.code}`, { field: t(error.field) });
  if (error instanceof StudioError) return t(error.key);
  if (error instanceof StudioAuthError) return t("errors.sessionInvalid");
  if (error instanceof StudioReadOnlyError) return t("errors.readOnly");
  if (DOMAIN_ERRORS.some((DomainError) => error instanceof DomainError)) return (error as Error).message;
  console.error("[studio] unexpected error while running an action:", error);
  return t("errors.unexpected");
}

/**
 * Single choke point for every mutation: authorizes the Studio session (and
 * refuses in read-only mode), runs the change and its audit entry in one
 * database transaction, and turns failures into a safe, displayable message
 * (domain errors verbatim; anything else logged server-side, never leaked).
 */
export async function mutate<T = undefined>(
  paths: string[],
  work: (tx: UnioraTransaction) => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    await requireWrite();
    const data = await getStorage().transaction(work);
    for (const path of paths) revalidatePath(path);
    return (data === undefined ? { ok: true } : { ok: true, data }) as ActionResult<T>;
  } catch (error) {
    return { ok: false, error: await describeError(error) };
  }
}

/** `mutate` for actions scoped to one organization: validates the (untrusted) organization id inside the guarded section. */
export async function mutateInOrg<T = undefined>(
  rawOrganizationId: unknown,
  pathsFor: (organizationId: string) => string[],
  work: (tx: UnioraTransaction, organizationId: string) => Promise<T>,
): Promise<ActionResult<T>> {
  let organizationId: string;
  try {
    organizationId = text(rawOrganizationId, "field.organization", { max: 128 });
  } catch (error) {
    return { ok: false, error: await describeError(error) };
  }
  return mutate(pathsFor(organizationId), (tx) => work(tx, organizationId));
}
