import "server-only";
import { createInvitationService, type InvitationSender, type InvitationService } from "@uniora/core";
import { getStorage } from "@/lib/db";
import { inviteUrlFactory } from "@/lib/invite-url";

export type MailStatus = "sending" | "no-smtp" | "package-missing" | "invalid-smtp";

export interface InvitationSetup {
  /** `null` when `UNIORA_INVITE_URL` is missing or unsafe: invitations can't be created from Studio. */
  service: InvitationService | null;
  mail: MailStatus;
}

const globalForStudio = globalThis as unknown as { __unioraStudioInvitations?: Promise<InvitationSetup> };

async function loadSender(): Promise<{ sender?: InvitationSender; mail: MailStatus }> {
  if (!Object.keys(process.env).some((key) => key.startsWith("UNIORA_SMTP_") && process.env[key]?.trim())) {
    return { mail: "no-smtp" };
  }
  let mailer: typeof import("@uniora/mailer-smtp");
  try {
    mailer = await import("@uniora/mailer-smtp");
  } catch {
    return { mail: "package-missing" };
  }
  try {
    return { sender: mailer.createSmtpInvitationSenderFromEnv(process.env), mail: "sending" };
  } catch {
    return { mail: "invalid-smtp" };
  }
}

/** The invitation service Studio uses, built once from `UNIORA_INVITE_URL` and the optional `UNIORA_SMTP_*` settings. */
export function getInvitationSetup(): Promise<InvitationSetup> {
  globalForStudio.__unioraStudioInvitations ??= (async () => {
    const acceptUrl = inviteUrlFactory(process.env.UNIORA_INVITE_URL);
    const { sender, mail } = await loadSender();
    return { service: acceptUrl ? createInvitationService({ storage: getStorage(), acceptUrl, sender }) : null, mail };
  })();
  return globalForStudio.__unioraStudioInvitations;
}
