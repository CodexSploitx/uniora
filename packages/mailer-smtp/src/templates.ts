import type { InvitationMessage } from "@uniora/core";
import { DEFAULT_LOCALE, resolveLocale, STRINGS, type EmailLocale } from "./locales.js";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface InvitationTemplateOptions {
  /** Shown in the header and footer. Default: the organization's name is used as the header and "UNIORA" in the footer. */
  brandName?: string;
  /** `#rrggbb` accent for the button and header rule. Default indigo. */
  brandColor?: string;
  /** Absolute https URL of a logo (max ~180×48 px works best). Omitted → text header. */
  logoUrl?: string;
  /** Shown in the footer help line. */
  supportEmail?: string;
  /** Used when `message.locale` is missing or unsupported. Default `en`. */
  defaultLocale?: EmailLocale;
}

export interface InvitationTemplateContext extends InvitationTemplateOptions {
  /** Display name of the person who invited, when you can resolve one. */
  inviterName?: string;
}

/** Replace this to take full control of the e-mail (any markup, any copy). */
export type InvitationTemplate = (message: InvitationMessage, context: InvitationTemplateContext) => RenderedEmail | Promise<RenderedEmail>;

const DEFAULT_COLOR = "#4f46e5";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** One line, bounded: names go into the Subject header and must never carry line breaks. */
export function singleLine(value: string, max = 80): string {
  const flat = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

function safeColor(color: string | undefined): string {
  return color && /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : DEFAULT_COLOR;
}

/** Black or white, whichever reads better on `hex` (WCAG relative luminance). */
function readableOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.4 ? "#111827" : "#ffffff";
}

function assertHttpUrl(value: string, what: string, httpsOnly = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${what} must be an absolute URL.`);
  }
  const allowed = httpsOnly ? ["https:"] : ["https:", "http:"];
  if (!allowed.includes(url.protocol)) throw new TypeError(`${what} must use ${httpsOnly ? "https" : "http(s)"}.`);
  return url.toString();
}

function formatDate(date: Date, locale: EmailLocale): string {
  try {
    return `${new Intl.DateTimeFormat(locale, { dateStyle: "long", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;
  } catch {
    return date.toISOString();
  }
}

/**
 * The default invitation e-mail: a responsive, table-based layout that holds up
 * in Outlook, Gmail and Apple Mail (inline styles, a bulletproof button with a
 * VML fallback, a hidden preheader, dark-mode support) plus a plain-text
 * alternative. Everything interpolated is escaped, the link must be http(s)
 * and the Subject is forced onto one line.
 */
export function renderInvitationEmail(message: InvitationMessage, context: InvitationTemplateContext = {}): RenderedEmail {
  const locale = resolveLocale(message.locale, context.defaultLocale ?? DEFAULT_LOCALE);
  const t = STRINGS[locale];
  const acceptUrl = assertHttpUrl(message.acceptUrl, "acceptUrl");
  const logoUrl = context.logoUrl ? assertHttpUrl(context.logoUrl, "logoUrl", true) : undefined;
  const color = safeColor(context.brandColor);
  const onColor = readableOn(color);

  const org = singleLine(message.organization.name, 120);
  const brand = singleLine(context.brandName ?? "UNIORA", 60);
  const inviter = context.inviterName ? singleLine(context.inviterName, 80) : undefined;
  const roles = message.roleNames.map((role) => singleLine(role, 60)).filter(Boolean);
  const when = formatDate(message.expiresAt, locale);
  const support = context.supportEmail ? singleLine(context.supportEmail, 120) : undefined;

  const subject = singleLine(fill(t.subject, { org }), 150);
  const introText = inviter ? fill(t.introWithInviter, { inviter, org }) : fill(t.intro, { org });
  const roleLabel = roles.length > 1 ? t.roleMany : t.roleOne;
  const heading = fill(t.heading, { org });
  const preheader = fill(t.preheader, { org });
  const expires = fill(t.expires, { date: when });
  const sentBy = fill(t.sentBy, { brand });
  const help = support ? fill(t.help, { support }) : undefined;

  // Each interpolated value is escaped on its own and then emphasised, so a
  // hostile name can't break out of the markup (and `$` in a name is inert).
  const e = escapeHtml;
  const introHtml = (inviter ? t.introWithInviter : t.intro)
    .split(/(\{org\}|\{inviter\})/)
    .map((part) =>
      part === "{org}" ? `<strong>${e(org)}</strong>` : part === "{inviter}" ? `<strong>${e(inviter ?? "")}</strong>` : e(part),
    )
    .join("");

  const url = e(acceptUrl);
  const header = logoUrl
    ? `<img src="${e(logoUrl)}" alt="${e(brand)}" height="32" style="display:block;border:0;height:32px;width:auto;max-width:180px;">`
    : `<span style="font-size:18px;font-weight:700;letter-spacing:.2px;color:#111827;" class="ink">${e(brand)}</span>`;

  const roleBlock = roles.length
    ? `<tr><td style="padding:0 40px 24px 40px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="panel" style="background:#f3f4f6;border-radius:10px;">
          <tr><td style="padding:14px 18px;font-size:13px;line-height:20px;color:#6b7280;" class="muted">${e(roleLabel)}</td></tr>
          <tr><td style="padding:0 18px 14px 18px;font-size:15px;line-height:22px;font-weight:600;color:#111827;" class="ink">${roles.map(e).join(" · ")}</td></tr>
        </table>
      </td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="${locale}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${e(subject)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  table,td{mso-table-lspace:0;mso-table-rspace:0;}
  img{-ms-interpolation-mode:bicubic;}
  @media (max-width:620px){ .container{width:100%!important;} .px{padding-left:24px!important;padding-right:24px!important;} }
  @media (prefers-color-scheme:dark){
    .bg{background:#0b0f19!important;} .card{background:#111827!important;border-color:#1f2937!important;}
    .ink{color:#f9fafb!important;} .body{color:#d1d5db!important;} .muted{color:#9ca3af!important;}
    .panel{background:#1f2937!important;} .rule{border-top-color:#1f2937!important;} .link{color:#a5b4fc!important;}
  }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:#f4f5f7;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${e(preheader)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" class="bg" style="background:#f4f5f7;">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" class="container card" style="width:560px;max-width:560px;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <tr><td class="px" style="padding:28px 40px 20px 40px;border-bottom:3px solid ${color};border-radius:14px 14px 0 0;">${header}</td></tr>
    <tr><td class="px ink" style="padding:32px 40px 8px 40px;font-size:24px;line-height:32px;font-weight:700;color:#111827;">${e(heading)}</td></tr>
    <tr><td class="px body" style="padding:8px 40px 24px 40px;font-size:16px;line-height:26px;color:#374151;">${introHtml}</td></tr>
    ${roleBlock}
    <tr><td class="px" align="left" style="padding:0 40px 24px 40px;">
      <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="20%" stroke="f" fillcolor="${color}"><w:anchorlock xmlns:w="urn:schemas-microsoft-com:office:word"/><center style="color:${onColor};font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${e(t.button)}</center></v:roundrect><![endif]-->
      <!--[if !mso]><!-- --><a href="${url}" target="_blank" rel="noopener" style="display:inline-block;background:${color};color:${onColor};font-size:16px;line-height:48px;font-weight:600;text-decoration:none;padding:0 32px;border-radius:10px;mso-hide:all;">${e(t.button)}</a><!--<![endif]-->
    </td></tr>
    <tr><td class="px muted" style="padding:0 40px 8px 40px;font-size:14px;line-height:22px;color:#6b7280;">${e(expires)}</td></tr>
    <tr><td class="px muted" style="padding:16px 40px 4px 40px;font-size:13px;line-height:20px;color:#6b7280;">${e(t.fallback)}</td></tr>
    <tr><td class="px" style="padding:0 40px 24px 40px;font-size:13px;line-height:20px;word-break:break-all;"><a class="link" href="${url}" style="color:${color};text-decoration:underline;">${url}</a></td></tr>
    <tr><td class="px" style="padding:0 40px;"><div class="rule" style="border-top:1px solid #e5e7eb;font-size:0;line-height:0;">&nbsp;</div></td></tr>
    <tr><td class="px muted" style="padding:20px 40px 6px 40px;font-size:13px;line-height:20px;color:#6b7280;">${e(t.ignore)}</td></tr>
    <tr><td class="px muted" style="padding:6px 40px ${help ? "6px" : "28px"} 40px;font-size:12px;line-height:18px;color:#9ca3af;">${e(sentBy)}</td></tr>
    ${help ? `<tr><td class="px muted" style="padding:0 40px 28px 40px;font-size:12px;line-height:18px;color:#9ca3af;">${e(help)}</td></tr>` : ""}
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    heading,
    "",
    introText,
    roles.length ? `${roleLabel}: ${roles.join(", ")}` : undefined,
    "",
    `${t.button}: ${acceptUrl}`,
    "",
    expires,
    "",
    t.ignore,
    "",
    "--",
    sentBy,
    help,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  return { subject, html, text };
}
