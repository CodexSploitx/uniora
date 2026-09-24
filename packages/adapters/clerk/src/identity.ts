import type { Identity } from "@uniora/core";
import type { ClerkAuthClient, ClerkVerifiedTokenPayload, ClerkVerifyTokenResult } from "./types.js";

// TypeScript desaparece en runtime (skill §40): `result.data` llega de un
// `ClerkAuthClient` provisto por la app, que puede estar mal implementado o
// envolver una librería que cambió de forma. Sin esta validación, un `sub`
// ausente/no-string produciría un `Identity` con subject inválido que igual
// atravesaría el resto del sistema (confusión de tipos / bypass por
// null-undefined, §8.9-8.10).
function hasValidSubject(
  payload: ClerkVerifiedTokenPayload | null | undefined,
): payload is ClerkVerifiedTokenPayload {
  return typeof payload?.sub === "string" && payload.sub.length > 0;
}

/**
 * Traduce el payload ya verificado de un session token de Clerk al
 * `Identity` que consume @uniora/core (docs/PROYECT.md §14). UNIORA nunca
 * posee la identidad: solo guarda esta referencia externa (`provider` +
 * `subject`), usando el claim `sub` de Clerk como subject estable en vez de
 * email/username (skill §15/§16).
 *
 * Lanza si `payload.sub` no es un string no vacío en vez de construir un
 * Identity con un subject inválido — fallar ruidosamente aquí es preferible
 * a dejar pasar una identidad que no se puede usar para aislar tenants de
 * forma fiable.
 */
export function toIdentity(payload: ClerkVerifiedTokenPayload): Identity {
  if (!hasValidSubject(payload)) {
    throw new TypeError(
      "Clerk token payload inválido: se esperaba un claim `sub` (string no vacío). No se puede " +
        "construir un Identity sin un subject estable (docs/PROYECT.md §14/§15).",
    );
  }

  return { provider: "clerk", subject: payload.sub };
}

/**
 * Verifica un session token de Clerk (vía la función que la app anfitriona
 * ya tiene configurada con sus propias credenciales) y devuelve el
 * `Identity` correspondiente, o `null` si el token no es válido.
 *
 * Nunca decodifica el JWT localmente sin verificar: delega la verificación
 * en el `ClerkAuthClient` provisto (que a su vez debe delegar en
 * `verifyToken`/`authenticateRequest` de Clerk), para evitar aceptar tokens
 * forjados o expirados.
 *
 * Contrato fail-closed (skill §1.1/INV-008): cualquier motivo por el que no
 * se pueda determinar la identidad con confianza — token vacío, `errors` en
 * el resultado, payload con forma inválida, o el propio cliente lanzando
 * (fallo de red/adapter) — devuelve `null`. Nunca lanza, para que un caller
 * no pueda convertir accidentalmente un fallo del adapter en acceso
 * permitido con un `catch` mal escrito.
 */
export async function resolveIdentity(
  verifyToken: ClerkAuthClient,
  sessionToken: string,
): Promise<Identity | null> {
  if (typeof sessionToken !== "string" || sessionToken.length === 0) {
    return null;
  }

  try {
    const result: ClerkVerifyTokenResult = await verifyToken(sessionToken);

    if (result.errors || !hasValidSubject(result.data)) {
      return null;
    }

    return toIdentity(result.data);
  } catch {
    return null;
  }
}
