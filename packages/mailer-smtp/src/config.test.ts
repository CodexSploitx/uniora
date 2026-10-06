import { describe, expect, it } from "vitest";
import { loadSmtpConfig, SmtpConfigError } from "./config.js";

const valid = { UNIORA_SMTP_HOST: "smtp.example.com", UNIORA_SMTP_FROM: "Acme <no-reply@acme.com>" };

describe("loadSmtpConfig", () => {
  it("applies safe defaults: STARTTLS on 587, TLS required, certificates verified", () => {
    expect(loadSmtpConfig(valid)).toEqual({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      auth: undefined,
      from: "Acme <no-reply@acme.com>",
      replyTo: undefined,
      requireTLS: true,
      rejectUnauthorized: true,
    });
  });

  it("uses implicit TLS on 465 and reads credentials", () => {
    const config = loadSmtpConfig({ ...valid, UNIORA_SMTP_PORT: "465", UNIORA_SMTP_USER: "u", UNIORA_SMTP_PASS: "p w" });
    expect(config).toMatchObject({ port: 465, secure: true, auth: { user: "u", pass: "p w" } });
  });

  it("reports every problem at once", () => {
    const error = (() => {
      try {
        loadSmtpConfig({ UNIORA_SMTP_PORT: "99999", UNIORA_SMTP_USER: "u", UNIORA_SMTP_SECURE: "maybe" });
      } catch (e) {
        return e as SmtpConfigError;
      }
    })();
    expect(error).toBeInstanceOf(SmtpConfigError);
    expect(error!.problems).toHaveLength(5);
    expect(error!.message).toMatch(/UNIORA_SMTP_HOST is required/);
    expect(error!.message).toMatch(/UNIORA_SMTP_FROM is required/);
  });

  it.each([
    [{ UNIORA_SMTP_HOST: "https://smtp.example.com" }, /bare host/],
    [{ UNIORA_SMTP_FROM: "a@b.com\r\nBcc: evil@x.com" }, /single valid address/],
    [{ UNIORA_SMTP_FROM: "a@b.com, c@d.com" }, /single valid address/],
    [{ UNIORA_SMTP_REPLY_TO: "nope" }, /REPLY_TO/],
    [{ UNIORA_SMTP_PASS: "secret" }, /together/],
  ])("rejects %j", (override, message) => {
    expect(() => loadSmtpConfig({ ...valid, ...override })).toThrow(message);
  });

  it("never echoes the password in an error", () => {
    expect(() => loadSmtpConfig({ ...valid, UNIORA_SMTP_PASS: "hunter2", UNIORA_SMTP_PORT: "x" })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }),
    );
  });
});
