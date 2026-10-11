/**
 * The shared rate limit of the API server (same model as `@uniora/postgres`'s `0044_rate_limits`): one token bucket per API key,
 * so several processes on the same file share one budget. An instance takes a small lease of tokens and spends it locally, so
 * this table is touched once per lease and not once per request.
 */
export const MIGRATION_0029_RATE_LIMITS = `
create table if not exists uniora_api_rate_limits (
  key text primary key check (length(key) between 1 and 64),
  tokens real not null check (tokens >= 0),
  updated_at integer not null
);
`;
