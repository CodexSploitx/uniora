import type { Identity, IdentityProfile } from "@uniora/core";
import { sanitizeProfile } from "@uniora/core";
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

/**
 * The e-mail address the provider has VERIFIED for this user, or `null` (never the unverified
 * one). This is what `InvitationService.accept({ verifiedEmail })` must receive: an invitation
 * is bound to an address, and an address the user merely typed in proves nothing (audit F-13).
 * Call it on the same already-verified user you built the identity from.
 */
export function toVerifiedEmail(user: SupabaseUser | null | undefined): string | null {
  if (typeof user?.email === "string" && Boolean(user.email_confirmed_at ?? user.confirmed_at)) {
    const email = user.email.trim();
    return email.length > 0 ? email : null;
  }
  return null;
}

/** The first value that is a non-blank string (providers disagree on which claim holds a name or a picture). */
function pick(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

/**
 * What a screen needs to show this person: display name, e-mail and the avatar URL, from the Supabase user (`user_metadata`
 * is what the OAuth provider or the sign-up form filled in). Only text and an `http(s)` URL come out, never an object. Fields
 * the user does not have are left out, so the result can go straight to `storage.profiles.upsert(identity, toProfile(user))`.
 * Display data only: it says nothing about who the person is or what they may do.
 */
export function toProfile(user: SupabaseUser | null | undefined): IdentityProfile {
  const metadata = typeof user?.user_metadata === "object" && user.user_metadata !== null ? user.user_metadata : {};
  return (
    sanitizeProfile({
      displayName: pick(metadata.full_name, metadata.name, metadata.display_name, metadata.user_name, metadata.preferred_username),
      email: pick(user?.email),
      avatarUrl: pick(metadata.avatar_url, metadata.picture),
    }) ?? {}
  );
}

/** `resolveIdentity` that also hands back the profile of the same verified user (one `getUser` call, not two). Same fail-closed contract: `null`, never a throw. */
export async function resolveIdentityWithProfile(
  client: SupabaseAuthClient,
  accessToken: string,
): Promise<{ identity: Identity; profile: IdentityProfile } | null> {
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return null;
  }

  try {
    const { data, error } = await client.auth.getUser(accessToken);

    if (error || !hasValidSubject(data.user)) {
      return null;
    }

    return { identity: toIdentity(data.user), profile: toProfile(data.user) };
  } catch {
    return null;
  }
}
