/**
 * The shared rate limit of the API server: one token bucket per API key, in `uniora_api.rate_limits`, so that N server
 * instances share one budget instead of each allowing the full rate. An instance does not touch this table on every request:
 * it takes a small lease of tokens (a tenth of the burst) and spends it locally, so the cost is one short statement per lease.
 * The table holds no secret and no identity, only a key id (the public half of an API key), a number and a moment, and rows
 * never outnumber the keys. The server's database user needs to read and write only this table besides the credentials.
 */
export const MIGRATION_0044_RATE_LIMITS = `
create table if not exists uniora_api.rate_limits (
  key text primary key check (length(key) between 1 and 64),
  tokens double precision not null check (tokens >= 0),
  updated_at timestamptz(3) not null
);
`;
