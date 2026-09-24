import type { Identity } from "@uniora/core";
import type { BetterAuthClient, BetterAuthHeaders, BetterAuthUser } from "./types.js";

// TypeScript desaparece en runtime (skill §40): `user` llega de un
// `BetterAuthClient` provisto por la app, que puede estar mal implementado o
// envolver una versión de Better Auth que cambió de forma. Sin esta
// validación, un `id` ausente/no-string produciría un `Identity` con
// subject inválido que igual atravesaría el resto del sistema (confusión de
// tipos / bypass por null-undefined, §8.9-8.10).
function hasValidSubject(user: BetterAuthUser | null | undefined): user is BetterAuthUser {
  return typeof user?.id === "string" && user.id.length > 0;
}

/**
 * Traduce el `user` de una sesión de Better Auth al `Identity` que consume
 * @uniora/core (docs/PROYECT.md §14). UNIORA nunca posee la identidad: solo
 * guarda esta referencia externa (`provider` + `subject`), usando el `id`
 * de Better Auth como subject estable en vez de email/username (skill
 * §15/§16).
 *
 * Lanza si `user.id` no es un string no vacío en vez de construir un
 * Identity con un subject inválido — fallar ruidosamente aquí es preferible
 * a dejar pasar una identidad que no se puede usar para aislar tenants de
 * forma fiable.
 */
export function toIdentity(user: BetterAuthUser): Identity {
  if (!hasValidSubject(user)) {
    throw new TypeError(
      "Better Auth user.id inválido: se esperaba un string no vacío. No se puede " +
        "construir un Identity sin un subject estable (docs/PROYECT.md §14/§15).",
    );
  }

  return { provider: "better-auth", subject: user.id };
}

/**
 * Resuelve la sesión actual de Better Auth a partir de los headers de la
 * request (vía la función que la app anfitriona ya tiene configurada con su
 * propia instancia `auth`) y devuelve el `Identity` correspondiente, o
 * `null` si no hay una sesión válida.
 *
 * Nunca decodifica ni interpreta la cookie/token localmente: delega por
 * completo en el `BetterAuthClient` provisto (que a su vez debe delegar en
 * `auth.api.getSession` real), porque Better Auth guarda sus sesiones del
 * lado del servidor y solo su propia instancia puede resolverlas.
 *
 * Contrato fail-closed (skill §1.1/INV-008): cualquier motivo por el que no
 * se pueda determinar la identidad con confianza — headers ausentes/con
 * forma inválida, sesión inexistente (`null`), `user` con forma inválida, o
 * el propio cliente lanzando (fallo de red/adapter/DB) — devuelve `null`.
 * Nunca lanza, para que un caller no pueda convertir accidentalmente un
 * fallo del adapter en acceso permitido con un `catch` mal escrito.
 */
export async function resolveIdentity(
  getSession: BetterAuthClient,
  headers: BetterAuthHeaders,
): Promise<Identity | null> {
  if (headers == null || typeof headers.get !== "function") {
    return null;
  }

  try {
    const result = await getSession(headers);

    if (!hasValidSubject(result?.user)) {
      return null;
    }

    return toIdentity(result.user);
  } catch {
    return null;
  }
}
