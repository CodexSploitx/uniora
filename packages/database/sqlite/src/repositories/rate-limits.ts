import type { RateLimitRepository } from "@uniora/core";
import { assertRateLease, leaseFromBucket } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";

/** The shared rate limit (`uniora_api_rate_limits`): read, refill, take and write back inside one atomic unit. */
export function createRateLimitRepository(db: SqliteExecutor): RateLimitRepository {
  return {
    async lease(input) {
      assertRateLease(input);
      const nowMs = (input.at ?? new Date()).getTime();
      return db.atomic(async () => {
        const { rows } = await db.query<{ tokens: number; updated_at: number }>("select tokens, updated_at from uniora_api_rate_limits where key = ?1", [input.key]);
        const current = rows[0];
        const { granted, tokens } = leaseFromBucket(current ? { tokens: current.tokens, updatedMs: current.updated_at } : undefined, input, nowMs);
        await db.query(
          `insert into uniora_api_rate_limits (key, tokens, updated_at) values (?1, ?2, ?3)
           on conflict (key) do update set tokens = excluded.tokens, updated_at = excluded.updated_at`,
          [input.key, tokens, Math.max(nowMs, current?.updated_at ?? 0)],
        );
        return granted;
      });
    },
  };
}
