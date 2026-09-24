import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { detectLocale } from "@/i18n/config";
import { SESSION_COOKIE, isAllowedHost, tokensMatch } from "@/lib/token";

const DENIALS = {
  notConfigured: { en: "not configured. Launch it with `npx uniora studio`.", es: "no está configurado. Ábrelo con `npx uniora studio`." },
  forbiddenHost: { en: "forbidden host.", es: "host no permitido." },
  invalidToken: { en: "invalid launch token.", es: "token de inicio no válido." },
  locked: {
    en: "locked. Open the URL printed by `npx uniora studio` to unlock it.",
    es: "bloqueado. Abre la URL que imprime `npx uniora studio` para desbloquearlo.",
  },
} as const;

function deny(request: NextRequest, status: number, reason: keyof typeof DENIALS): NextResponse {
  const locale = detectLocale(request.headers.get("accept-language"));
  return new NextResponse(`UNIORA Studio: ${DENIALS[reason][locale]}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/**
 * Studio is a local admin tool with direct database access, so it fails
 * closed: no launch token configured, a non-loopback Host header (DNS
 * rebinding), or a missing/invalid session cookie all get denied before any
 * page or Server Action runs. The launch URL printed by `npx uniora studio`
 * carries `?token=`, which is exchanged once for an HttpOnly, SameSite=Strict
 * cookie and stripped from the URL.
 */
export function proxy(request: NextRequest) {
  const token = process.env.UNIORA_STUDIO_TOKEN;
  if (!token) return deny(request, 503, "notConfigured");

  if (!isAllowedHost(request.headers.get("host"), process.env.UNIORA_STUDIO_PORT)) {
    return deny(request, 403, "forbiddenHost");
  }

  const supplied = request.nextUrl.searchParams.get("token");
  if (supplied !== null) {
    if (!tokensMatch(supplied, token)) return deny(request, 403, "invalidToken");
    const clean = request.nextUrl.clone();
    clean.searchParams.delete("token");
    const response = NextResponse.redirect(clean);
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      path: "/",
    });
    return response;
  }

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  if (!cookie || !tokensMatch(cookie, token)) {
    return deny(request, 401, "locked");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
