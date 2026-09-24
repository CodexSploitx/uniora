import type { Identity } from "@uniora/core";
import type { Auth0VerifiedTokenPayload, Auth0VerifyTokenFn } from "./types.js";

// TypeScript desaparece en runtime (skill §40): `payload` llega de un
// `Auth0VerifyTokenFn` provisto por la app, que puede estar mal
// implementado o envolver una librería JWT que cambió de forma. Sin esta
// validación, un `sub` ausente/no-string produciría un `Identity` con
// subject inválido que igual atravesaría el resto del sistema (confusión de
// tipos / bypass por null-undefined, §8.9-8.10).
function hasValidSubject(
  payload: Auth0VerifiedTokenPayload | null | undefined,
): payload is Auth0VerifiedTokenPayload {
  return typeof payload?.sub === "string" && payload.sub.length > 0;
}

/**
 * Traduce el payload ya verificado de un access token de Auth0 al
 * `Identity` que consume @uniora/core (docs/PROYECT.md §14). UNIORA nunca
 * posee la identidad: solo guarda esta referencia externa (`provider` +
 * `subject`), usando el claim `sub` de Auth0 como subject estable en vez de
 * email/username (skill §15/§16).
 *
 * Lanza si `payload.sub` no es un string no vacío en vez de construir un
 * Identity con un subject inválido — fallar ruidosamente aquí es preferible
 * a dejar pasar una identidad que no se puede usar para aislar tenants de
 * forma fiable.
 */
export function toIdentity(payload: Auth0VerifiedTokenPayload): Identity {
  if (!hasValidSubject(payload)) {
    throw new TypeError(
      "Auth0 token payload inválido: se esperaba un claim `sub` (string no vacío). No se puede " +
        "construir un Identity sin un subject estable (docs/PROYECT.md §14/§15).",
    );
  }

  return { provider: "auth0", subject: payload.sub };
}

/**
 * Verifica un access token de Auth0 (vía la función que la app anfitriona
 * ya tiene configurada con su propio domain/audience y su librería
 * JWT/JWKS de elección) y devuelve el `Identity` correspondiente, o `null`
 * si el token no es válido.
 *
 * Nunca decodifica el JWT localmente sin verificar: delega por completo en
 * el `Auth0VerifyTokenFn` provisto, para evitar aceptar tokens forjados o
 * expirados.
 *
 * Contrato fail-closed (skill §1.1/INV-008): cualquier motivo por el que no
 * se pueda determinar la identidad con confianza — token vacío, el
 * verificador lanzando (firma inválida, expirado, issuer/audience
 * incorrectos, fallo de red al resolver JWKS), o un payload con forma
 * inválida — devuelve `null`. Nunca lanza, para que un caller no pueda
 * convertir accidentalmente un fallo del adapter en acceso permitido con un
 * `catch` mal escrito.
 */
export async function resolveIdentity(
  verifyToken: Auth0VerifyTokenFn,
  accessToken: string,
): Promise<Identity | null> {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }

  try {
    const payload = await verifyToken(accessToken);

    if (!hasValidSubject(payload)) {
      return null;
    }

    return toIdentity(payload);
  } catch {
    return null;
  }
}
