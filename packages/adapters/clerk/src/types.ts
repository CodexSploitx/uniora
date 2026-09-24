/**
 * Claims mínimos que este adapter necesita del token de sesión ya verificado
 * por Clerk. `sub` es el claim estándar JWT Subject (RFC7519 §4.1.2), que
 * Clerk usa como ID estable del usuario actual de la sesión — igual en v1 y
 * v2 de sus session tokens (https://clerk.com/docs/backend-requests/resources/session-tokens).
 */
export interface ClerkVerifiedTokenPayload {
  readonly sub: string;
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
