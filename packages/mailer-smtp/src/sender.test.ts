import { createServer, type Server } from "node:net";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInvitationService, createMemoryStorage, createOrganizationWithOwner, InvitationDeliveryError } from "@uniora/core";
import type { InvitationMessage } from "@uniora/core";
import { createSmtpInvitationSender, createSmtpInvitationSenderFromEnv, isPermanentSmtpFailure, type MailTransport } from "./sender.js";
import type { SmtpConfig } from "./config.js";

const config: SmtpConfig = {
  host: "127.0.0.1",
  port: 2525,
  secure: false,
  from: "Acme <no-reply@acme.com>",
  replyTo: "help@acme.com",
  requireTLS: false,
  rejectUnauthorized: true,
};

const message: InvitationMessage = {
  invitationId: "inv-1",
  to: "ana@example.com",
  organization: { id: "org-1", name: "Acme Motors", slug: "acme-motors" },
  roleNames: ["Editor"],
  invitedBy: { provider: "supabase", subject: "u1" },
  acceptUrl: "https://app.test/invite/uinv_tok",
  expiresAt: new Date("2026-10-13T12:00:00Z"),
};
const context = { signal: new AbortController().signal, attempt: 1 };

function fakeTransport(sendMail: MailTransport["sendMail"]): MailTransport {
  return { sendMail };
}

describe("createSmtpInvitationSender (fake transport)", () => {
  it("renders and sends with safe headers, resolving the inviter's name", async () => {
    const sendMail = vi.fn(async () => ({}));
    const sender = createSmtpInvitationSender({
      config,
      transport: fakeTransport(sendMail),
      resolveInviterName: async () => "Ana Pérez",
      brandName: "Acme",
    });
    await sender.send(message, context);

    const mail = sendMail.mock.calls[0]![0] as Parameters<MailTransport["sendMail"]>[0];
    expect(mail).toMatchObject({ from: config.from, to: "ana@example.com", replyTo: "help@acme.com" });
    expect(mail.html).toContain("Ana Pérez");
    expect(mail.headers).toMatchObject({ "Auto-Submitted": "auto-generated", "X-Entity-Ref-ID": "inv-1.1" });
    expect(JSON.stringify(mail.headers)).not.toContain("uinv_tok");
  });

  it("a failing name lookup doesn't block the e-mail", async () => {
    const sendMail = vi.fn(async () => ({}));
    const sender = createSmtpInvitationSender({
      config,
      transport: fakeTransport(sendMail),
      resolveInviterName: async () => {
        throw new Error("db down");
      },
    });
    await sender.send(message, context);
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it("classifies failures: auth and 5xx are permanent, network and 4xx are retried", async () => {
    const cases: [object, boolean][] = [
      [{ code: "EAUTH", responseCode: 535, message: "bad credentials" }, true],
      [{ code: "EENVELOPE", responseCode: 550, message: "no such user" }, true],
      [{ responseCode: 421, message: "try later" }, false],
      [{ code: "ECONNECTION", message: "refused" }, false],
      [{ code: "ETIMEDOUT", message: "timeout" }, false],
    ];
    for (const [failure, permanent] of cases) {
      expect(isPermanentSmtpFailure(failure)).toBe(permanent);
      const sender = createSmtpInvitationSender({
        config,
        transport: fakeTransport(async () => {
          throw Object.assign(new Error((failure as { message: string }).message), failure);
        }),
      });
      const error = await sender.send(message, context).catch((e) => e);
      expect(error).toBeInstanceOf(InvitationDeliveryError);
      expect(error.permanent).toBe(permanent);
    }
  });

  it("verify() surfaces a bad configuration as a delivery error", async () => {
    const sender = createSmtpInvitationSender({
      config,
      transport: { sendMail: async () => ({}), verify: async () => Promise.reject(Object.assign(new Error("nope"), { code: "EAUTH" })) },
    });
    await expect(sender.verify()).rejects.toMatchObject({ permanent: true });
  });

  it("fromEnv fails fast with the full list of problems", () => {
    expect(() => createSmtpInvitationSenderFromEnv({})).toThrow(/UNIORA_SMTP_HOST is required/);
  });
});

describe("end to end over a real SMTP server", () => {
  let server: SMTPServer;
  let port: number;
  const inbox: { from: string; to: string[]; raw: string }[] = [];
  let rejectNext = false;

  beforeAll(async () => {
    server = new SMTPServer({
      authOptional: true,
      disabledCommands: ["STARTTLS"],
      logger: false,
      onRcptTo(address, _session, callback) {
        if (rejectNext) {
          rejectNext = false;
          return callback(Object.assign(new Error("550 No such user here"), { responseCode: 550 }));
        }
        callback();
      },
      onData(stream, session, callback) {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk: Buffer) => chunks.push(chunk));
        stream.on("end", () => {
          inbox.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "", to: session.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString("utf8") });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => {
      const probe: Server = createServer().listen(0, "127.0.0.1", () => {
        port = (probe.address() as { port: number }).port;
        probe.close(() => server.listen(port, "127.0.0.1", resolve));
      });
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const decode = (raw: string) =>
    raw.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

  it("delivers an invitation created by the service, link included", async () => {
    const storage = createMemoryStorage();
    await createOrganizationWithOwner(storage, {
      organizationId: "org-1",
      organizationName: "Acme Motors",
      ownerRoleId: "role-owner",
      membershipId: "m-owner",
      ownerIdentity: { provider: "supabase", subject: "owner" },
    });
    await storage.roles.create({ id: "role-editor", organizationId: "org-1", name: "Editor", permissionKeys: [] });

    const sender = createSmtpInvitationSender({ config: { ...config, port }, brandName: "Acme" });
    await sender.verify();
    const service = createInvitationService({
      storage,
      sender,
      acceptUrl: (token) => `https://app.test/invite/${token}`,
      retry: { baseDelayMs: 1, maxAttempts: 2 },
    });
    const result = await service.invite({
      organizationId: "org-1",
      email: "Ana@Example.com",
      roleIds: ["role-editor"],
      invitedBy: { provider: "supabase", subject: "owner" },
      locale: "es",
    });
    sender.close();

    expect(result.delivery).toMatchObject({ status: "sent", attempts: 1 });
    expect(inbox).toHaveLength(1);
    const delivered = inbox.at(-1)!;
    expect(delivered.to).toEqual(["ana@example.com"]);
    const body = decode(delivered.raw);
    expect(body).toContain("Subject: Te invitaron a unirte a Acme Motors");
    expect(body).toContain("Content-Type: multipart/alternative");
    expect(body).toContain(result.acceptUrl);
    expect(body).toContain("Auto-Submitted: auto-generated");
  });

  it("a rejected recipient fails permanently without retrying", async () => {
    const sender = createSmtpInvitationSender({ config: { ...config, port } });
    rejectNext = true;
    const error = await sender.send(message, context).catch((e) => e);
    sender.close();
    expect(error).toBeInstanceOf(InvitationDeliveryError);
    expect(error.permanent).toBe(true);
    expect(error.message).toContain("550");
  });

  it("an unreachable server is transient", async () => {
    const sender = createSmtpInvitationSender({ config: { ...config, port: 1 }, pool: false });
    const error = await sender.send(message, context).catch((e) => e);
    expect(error).toBeInstanceOf(InvitationDeliveryError);
    expect(error.permanent).toBe(false);
  });
});
