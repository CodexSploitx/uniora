"use server";

import { getInvitationSetup } from "@/lib/invitations";
import { StudioError } from "@/lib/validate";
import { guarded, studioActor, text, type ActionResult } from "@/actions/mutate";
import { getT } from "@/i18n/server";

const paths = (organizationId: string) => [`/organizations/${organizationId}`];

export interface InviteOutcome {
  /** The link with the secret token. Shown to the operator once; it can't be recovered later. */
  acceptUrl: string;
  delivery: "sent" | "failed" | "skipped";
  error?: string;
}

async function requireService() {
  const { service } = await getInvitationSetup();
  if (!service) throw new StudioError("errors.inviteUrlMissing");
  return service;
}

export async function inviteMember(args: { organizationId: string; email: string; roleId: string }): Promise<ActionResult<InviteOutcome>> {
  return guarded(paths(String(args?.organizationId ?? "")), async () => {
    const organizationId = text(args?.organizationId, "field.organization", { max: 128 });
    const email = text(args?.email, "field.email", { max: 254 });
    const roleId = text(args?.roleId, "field.role", { max: 128 });
    const service = await requireService();
    const { locale } = await getT();
    const result = await service.invite({ organizationId, email, roleIds: [roleId], invitedBy: studioActor(), locale });
    return { acceptUrl: result.acceptUrl, delivery: result.delivery.status, error: result.delivery.error };
  });
}

export async function resendInvitation(args: { organizationId: string; invitationId: string }): Promise<ActionResult<InviteOutcome>> {
  return guarded(paths(String(args?.organizationId ?? "")), async () => {
    const organizationId = text(args?.organizationId, "field.organization", { max: 128 });
    const invitationId = text(args?.invitationId, "field.invitation", { max: 128 });
    const service = await requireService();
    const { locale } = await getT();
    const result = await service.resend({ organizationId, invitationId, actor: studioActor() }, { locale });
    return { acceptUrl: result.acceptUrl, delivery: result.delivery.status, error: result.delivery.error };
  });
}

export async function revokeInvitation(args: { organizationId: string; invitationId: string }): Promise<ActionResult> {
  return guarded(paths(String(args?.organizationId ?? "")), async () => {
    const organizationId = text(args?.organizationId, "field.organization", { max: 128 });
    const invitationId = text(args?.invitationId, "field.invitation", { max: 128 });
    const service = await requireService();
    await service.revoke({ organizationId, invitationId, actor: studioActor() });
  });
}
