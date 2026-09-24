/**
 * Forma mínima del cliente de Supabase que este adapter necesita.
 *
 * No dependemos de `@supabase/supabase-js` como dependencia dura: el cliente
 * real de esa librería ya cumple esta forma estructuralmente, así que la app
 * anfitriona pasa el cliente que ya tiene configurado (con su propia URL/key,
 * que ella misma debe cargar desde su `.env` — este adapter nunca las lee ni
 * las hardcodea).
 */
export interface SupabaseUser {
  readonly id: string;
}

export interface SupabaseAuthResponse {
  readonly data: { readonly user: SupabaseUser | null };
  readonly error: unknown;
}

export interface SupabaseAuthClient {
  readonly auth: {
    getUser(accessToken: string): Promise<SupabaseAuthResponse>;
  };
}
