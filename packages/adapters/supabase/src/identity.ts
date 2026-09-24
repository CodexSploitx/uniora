import type { Identity } from "@uniora/core";
import type { SupabaseAuthClient, SupabaseUser } from "./types.js";

// TypeScript desaparece en runtime (skill §40): `data.user` llega deserializado
// de una respuesta HTTP (o de un `SupabaseAuthClient` provisto por la app, que
// puede estar mal implementado), así que su forma real nunca está garantizada
// por el tipo `SupabaseUser`. Sin esta validación, un `id` ausente/no-string
// produciría un `Identity` con `subject` inválido que igual atravesaría el
// resto del sistema (confusión de tipos / bypass por null-undefined, §8.9-8.10).
function hasValidSubject(user: SupabaseUser | null | undefined): user is SupabaseUser {
  return typeof user?.id === "string" && user.id.length > 0;
}

/**
 * Traduce un usuario de Supabase Auth al `Identity` que consume @uniora/core
 * (docs/PROYECT.md §14). UNIORA nunca posee la identidad: solo guarda esta
 * referencia externa (`provider` + `subject`).
 *
 * Lanza si `user.id` no es un string no vacío en vez de construir un Identity
 * con un subject inválido — fallar ruidosamente aquí es preferible a dejar
 * pasar una identidad que no se puede usar para aislar tenants de forma fiable.
 */
export function toIdentity(user: SupabaseUser): Identity {
  if (!hasValidSubject(user)) {
    throw new TypeError(
      "Supabase user.id inválido: se esperaba un string no vacío. No se puede " +
        "construir un Identity sin un subject estable (docs/PROYECT.md §14/§15).",
    );
  }

  return { provider: "supabase", subject: user.id };
}

/**
 * Verifica un access token contra el servidor de Supabase Auth (vía el
 * cliente que la app anfitriona ya tiene configurado) y devuelve el
 * `Identity` correspondiente, o `null` si el token no es válido.
 *
 * Nunca decodifica el JWT localmente sin verificar: delega la verificación
 * en Supabase (`auth.getUser`) para evitar aceptar tokens forjados o expirados.
 *
 * Contrato fail-closed (skill §1.1/INV-008): cualquier motivo por el que no
 * se pueda determinar la identidad con confianza — token vacío, error de
 * Supabase, `user` con forma inválida, o el propio cliente lanzando (fallo de
 * red/adapter) — devuelve `null`. Nunca lanza, para que un caller no pueda
 * convertir accidentalmente un fallo del adapter en acceso permitido con un
 * `catch` mal escrito.
 */
export async function resolveIdentity(
  client: SupabaseAuthClient,
  accessToken: string,
): Promise<Identity | null> {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }

  try {
    const { data, error } = await client.auth.getUser(accessToken);

    if (error || !hasValidSubject(data.user)) {
      return null;
    }

    return toIdentity(data.user);
  } catch {
    return null;
  }
}
