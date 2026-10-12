import type { Identity, IdentityProfile } from "@uniora/core";
import { sanitizeProfile } from "@uniora/core";
import type { ClerkAuthClient, ClerkProfileSource, ClerkVerifiedTokenPayload, ClerkVerifyTokenResult } from "./types.js";

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

/**
 * The e-mail address the provider has VERIFIED for this user, or `null` (never the unverified
 * one). This is what `InvitationService.accept({ verifiedEmail })` must receive: an invitation
 * is bound to an address, and an address the user merely typed in proves nothing (audit F-13).
 * Call it on the same already-verified payload you built the identity from.
 */
export function toVerifiedEmail(payload: ClerkVerifiedTokenPayload | null | undefined): string | null {
  if (typeof payload?.email === "string" && payload.email_verified === true) {
    const email = payload.email.trim();
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
 * What a screen needs to show this person: display name, e-mail and the avatar URL. Accepts the verified session-token payload
 * (add the claims to your Clerk session token template: `name`, `email`, `picture` or `image_url`) and also a Clerk Backend `User`
 * (`clerkClient.users.getUser(id)`: `firstName`, `lastName`, `imageUrl`, `emailAddresses`), which is the way when the template has
 * no profile claims. Only text and an `http(s)` URL come out, never an object; fields the user does not have are left out, so the
 * result can go straight to `storage.profiles.upsert(identity, toProfile(source))`. Display data only.
 */
export function toProfile(source: ClerkProfileSource | null | undefined): IdentityProfile {
  const user: ClerkProfileSource = typeof source === "object" && source !== null ? source : {};
  const fromParts = [pick(user.first_name, user.firstName), pick(user.last_name, user.lastName)].filter(Boolean).join(" ");
  const emails = Array.isArray(user.emailAddresses) ? user.emailAddresses : [];
  const primaryEmail = emails.find((entry) => entry?.id !== undefined && entry.id === user.primaryEmailAddressId) ?? emails[0];
  return (
    sanitizeProfile({
      displayName: pick(user.name, user.full_name, fromParts, user.username),
      email: pick(user.email, primaryEmail?.emailAddress),
      avatarUrl: pick(user.picture, user.image_url, user.imageUrl),
    }) ?? {}
  );
}

/** `resolveIdentity` that also hands back the profile of the same verified payload (one `verifyToken` call, not two). Same fail-closed contract: `null`, never a throw. */
export async function resolveIdentityWithProfile(
  verifyToken: ClerkAuthClient,
  sessionToken: string,
): Promise<{ identity: Identity; profile: IdentityProfile } | null> {
  if (typeof sessionToken !== "string" || sessionToken.length === 0) {
    return null;
  }

  try {
    const result: ClerkVerifyTokenResult = await verifyToken(sessionToken);

    if (result.errors || !hasValidSubject(result.data)) {
      return null;
    }

    return { identity: toIdentity(result.data), profile: toProfile(result.data) };
  } catch {
    return null;
  }
}
