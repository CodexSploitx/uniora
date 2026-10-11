import type { RateLimitRepository } from "@uniora/core";
import { assertRateLease } from "@uniora/core";
import type { Queryable } from "../queryable.js";

/**
 * The shared rate limit (`uniora_api.rate_limits`). One statement under the row's lock does the whole lease, so concurrent instances
 * never hand out more than the bucket holds, and the database's own clock is used (`clock_timestamp()`) so instances with different
 * clocks agree. The arithmetic is `leaseFromBucket` of `@uniora/core`; the conformance suite holds both to the same answers.
 */
export function createRateLimitRepository(db: Queryable): RateLimitRepository {
  return {
    async lease(input) {
      assertRateLease(input);
      const at = input.at ?? null;
      // A bucket nobody has used starts full. Two instances creating it at once is harmless: the second does nothing.
      await db.query(
        `insert into uniora_api.rate_limits (key, tokens, updated_at) values ($1, $2::double precision, coalesce($3::timestamptz, clock_timestamp()))
         on conflict (key) do nothing`,
        [input.key, input.burst, at],
      );
      const result = await db.query<{ granted: number }>(
        `with now as (select coalesce($5::timestamptz, clock_timestamp()) as at),
              old as (select tokens, updated_at from uniora_api.rate_limits where key = $1 for update),
              held as (select least($2::double precision, old.tokens + greatest(0, extract(epoch from (now.at - old.updated_at))) * $3::double precision) as tokens from old, now),
              got as (select least($4::double precision, floor(held.tokens)) as granted, held.tokens from held)
         update uniora_api.rate_limits set tokens = got.tokens - got.granted, updated_at = greatest(now.at, rate_limits.updated_at)
           from got, now where rate_limits.key = $1
         returning got.granted as granted`,
        [input.key, input.burst, input.perSecond, input.amount, at],
      );
      return Number(result.rows[0]?.granted ?? 0);
    },
  };
}
