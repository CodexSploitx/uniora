/**
 * Forma mínima de los headers de la request entrante que este adapter
 * necesita reenviar a Better Auth. A diferencia de Supabase/Clerk, Better
 * Auth no usa por defecto un JWT autoverificable: usa un session token
 * opaco guardado en su propia base de datos, y la única forma soportada de
 * resolverlo es leyendo la cookie (o el header `Authorization: Bearer`, con
 * el plugin Bearer) desde los headers de la request
 * (https://better-auth.com/docs/concepts/session-management). No hay un
 * string de token aislado que este adapter pueda verificar por sí solo.
 *
 * Esta interfaz coincide estructuralmente con el `Headers` estándar de Web
 * (Fetch API) — `request.headers` en la mayoría de frameworks, o el helper
 * `headers()` de Next.js — sin depender de sus tipos DOM.
 */
export interface BetterAuthHeaders {
  get(name: string): string | null;
}

/**
 * Forma mínima del usuario que este adapter necesita del resultado de
 * `auth.api.getSession(...)`. `id` es siempre un string (confirmado leyendo
 * `packages/core/src/db/schema/shared.ts::coreSchema` en el código fuente
 * oficial de Better Auth — `id: z.string()`), estable independientemente de
 * qué proveedor OAuth/credenciales use el usuario para autenticarse.
 */
export interface BetterAuthUser {
  readonly id: string;
}

/**
 * Forma del resultado de `auth.api.getSession({ headers })`: nunca lanza
 * por ausencia de sesión válida, devuelve `null` (confirmado leyendo
 * `packages/better-auth/src/api/routes/session.ts` del SDK oficial, que
 * retorna `Promise<{ session; user } | null>`). Este adapter solo necesita
 * `user`.
 */
export type BetterAuthSessionResult = { readonly user: BetterAuthUser } | null;

/**
 * Forma mínima que este adapter necesita para resolver la sesión actual de
 * Better Auth. No dependemos de `better-auth` como dependencia dura: la app
 * anfitriona ya tiene su propia instancia `auth` configurada (con su base
 * de datos, secret y adapters) y nos pasa una función que delega en
 * `auth.api.getSession(...)` — este adapter nunca lee ni asume esa
 * configuración (misma regla que `@uniora/supabase` y `@uniora/clerk`).
 *
 * ```ts
 * const betterAuthClient: BetterAuthClient = (headers) =>
 *   auth.api.getSession({ headers });
 * ```
 */
export type BetterAuthClient = (headers: BetterAuthHeaders) => Promise<BetterAuthSessionResult>;
