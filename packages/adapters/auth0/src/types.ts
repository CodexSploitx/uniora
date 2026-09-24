/**
 * Claims mínimos que este adapter necesita del access token de Auth0 ya
 * verificado. `sub` es el ID de usuario de Auth0 (p.ej. `auth0|653f...`,
 * `google-oauth2|109...`) — confirmado en el quickstart oficial de Auth0
 * para APIs Node.js, donde el usuario autenticado se lee como
 * `req.auth.payload.sub` (https://auth0.com/docs/quickstart/backend/nodejs/interactive).
 */
export interface Auth0VerifiedTokenPayload {
  readonly sub: string;
}

/**
 * Forma mínima que este adapter necesita para verificar un access token de
 * Auth0. No dependemos de ningún SDK de Auth0 como dependencia dura.
 *
 * A diferencia de Clerk (`@clerk/backend` publica `verifyToken` como
 * función framework-independent) o Supabase (`SupabaseAuthClient` es la
 * forma estructural mínima de su cliente real), Auth0 **no publica un
 * paquete Node.js oficial de verificación que no dependa de Express**: su
 * único paquete mantenido es `express-oauth2-jwt-bearer`, acoplado a
 * middleware de Express, y el verificador interno que usa por debajo
 * (`access-token-jwt`, en el monorepo `auth0/node-oauth2-jwt-bearer`) está
 * marcado explícitamente como "not published" — no es una dependencia
 * instalable.
 *
 * Por eso este adapter acepta una función de verificación de JWT genérica
 * (`Auth0VerifyTokenFn`) que la app anfitriona construye con la librería
 * JWT/JWKS que prefiera (`jose`, `jsonwebtoken` + `jwks-rsa`, etc.), atada a
 * su propio `domain`/`audience` (cargados desde su `.env`). Este adapter
 * nunca los lee ni los asume.
 *
 * Contrato: como la inmensa mayoría de verificadores JWT (`jose.jwtVerify`,
 * `jsonwebtoken.verify`), se espera que **lance** ante un token
 * inválido/expirado/mal firmado en vez de devolver un resultado con
 * `error` — `resolveIdentity` ya captura cualquier excepción y falla
 * cerrado (ver identity.ts).
 *
 * ```ts
 * import { createRemoteJWKSet, jwtVerify } from "jose";
 *
 * const jwks = createRemoteJWKSet(
 *   new URL(`https://${process.env.AUTH0_DOMAIN}/.well-known/jwks.json`),
 * );
 *
 * const auth0VerifyToken: Auth0VerifyTokenFn = async (token) => {
 *   const { payload } = await jwtVerify(token, jwks, {
 *     issuer: `https://${process.env.AUTH0_DOMAIN}/`,
 *     audience: process.env.AUTH0_AUDIENCE,
 *   });
 *   return { sub: payload.sub as string };
 * };
 * ```
 */
export type Auth0VerifyTokenFn = (accessToken: string) => Promise<Auth0VerifiedTokenPayload>;
