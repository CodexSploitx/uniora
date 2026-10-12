/**
 * Claims mínimos que este adapter necesita del token de sesión ya verificado
 * por Clerk. `sub` es el claim estándar JWT Subject (RFC7519 §4.1.2), que
 * Clerk usa como ID estable del usuario actual de la sesión — igual en v1 y
 * v2 de sus session tokens (https://clerk.com/docs/backend-requests/resources/session-tokens).
 */
export interface ClerkVerifiedTokenPayload {
  readonly sub: string;
  /** Only present if your Clerk session token template adds the `email` claim. */
  readonly email?: string;
  /** Only present if your session token template adds `email_verified`. */
  readonly email_verified?: boolean;
}

/**
 * Where `toProfile` reads a person from: the verified session-token payload (with the claims your Clerk session token template adds:
 * `name`, `email`, `picture` or `image_url`...) or a Clerk Backend `User` (`firstName`, `lastName`, `imageUrl`, `emailAddresses`).
 * Every field is optional: a missing one is simply left out of the profile.
 */
export interface ClerkProfileSource {
  readonly name?: string | null;
  readonly full_name?: string | null;
  readonly first_name?: string | null;
  readonly last_name?: string | null;
  readonly username?: string | null;
  readonly email?: string | null;
  readonly picture?: string | null;
  readonly image_url?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly imageUrl?: string | null;
  readonly primaryEmailAddressId?: string | null;
  readonly emailAddresses?: ReadonlyArray<{ readonly id?: string; readonly emailAddress?: string }> | null;
}

/**
 * Forma del resultado de `verifyToken(token, options)` en `@clerk/backend`:
 * nunca lanza por un token inválido/expirado, devuelve `{ data }` en éxito o
 * `{ errors }` en fallo (`JwtReturnType<JwtPayload, TokenVerificationError>`
 * en el SDK oficial — https://clerk.com/docs/reference/backend/verify-token).
 */
export type ClerkVerifyTokenResult =
  | { readonly data: ClerkVerifiedTokenPayload; readonly errors?: undefined }
  | { readonly data?: undefined; readonly errors: readonly unknown[] };

/**
 * Forma mínima que este adapter necesita para verificar un session token de
 * Clerk. No dependemos de `@clerk/backend` como dependencia dura: la app
 * anfitriona ya tiene su `secretKey`/`jwtKey` cargados desde su propio
 * `.env`, así que le pasamos la responsabilidad de invocar
 * `verifyToken(token, options)` de esa librería (o una implementación
 * equivalente) ya parcialmente aplicada con esas credenciales — este adapter
 * nunca las lee ni las asume (misma regla que `@uniora/supabase`).
 *
 * `@clerk/backend`'s `verifyToken` real cumple esta forma estructuralmente
 * una vez que la app anfitriona la ata a sus opciones:
 *
 * ```ts
 * const clerkAuthClient: ClerkAuthClient = (token) =>
 *   verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
 * ```
 */
export type ClerkAuthClient = (token: string) => Promise<ClerkVerifyTokenResult>;
