import { ApiError, errors } from "../errors.js";
import type { RouteContext } from "../route.js";
import { s } from "../schema.js";

/** The text fields every request is made of. Bounded and free of control characters (the parser enforces the latter). */
export const id = (description: string, example?: string) => s.string({ min: 1, max: 200, description, ...(example ? { example } : {}) });

/** A person, as the caller's auth provider knows them. `provider` may be left out when the server has a default label. */
export const IdentityInput = s.object(
  {
    provider: s.optional(
      s.string({
        min: 1,
        max: 64,
        pattern: /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,
        description:
          "An opaque label for the auth system the subject belongs to (not necessarily its vendor name). Omit it to use the server's default label.",
        example: "main",
      }),
    ),
    subject: s.string({ min: 1, max: 500, description: "The user's stable id in your auth provider. Never an e-mail address.", example: "3f2c9a10-8b1e-4c2d-9f7a-1e2b3c4d5e6f" }),
  },
  { description: "Who the question is about." },
);

export const IdentityOutput = s.object({
  provider: s.string({ max: 200 }),
  subject: s.string({ max: 500 }),
});

export const PageQuery = {
  limit: s.optional(s.int({ min: 1, max: 1000, description: "Items per page. At most the server's maximum (100 unless configured).", example: 25 })),
  cursor: s.optional(s.string({ min: 1, max: 600, description: "The `nextCursor` of the previous page." })),
  q: s.optional(s.string({ min: 1, max: 200, description: "Case-insensitive text to look for." })),
} as const;

export const pageOf = <I extends ReturnType<typeof s.object>>(item: I) =>
  s.object({
    items: s.array(item, { max: 1000 }),
    nextCursor: s.nullable(s.string({ max: 600, description: "Pass it back as `cursor` for the next page; `null` on the last one." })),
  });

/** Items per page: what the caller asked for, within the server's limits. Asking for more than the maximum is an error, not a silent cut. */
export function pageSize(ctx: RouteContext, requested: number | undefined): number {
  const size = requested ?? ctx.config.limits.defaultPageSize;
  if (size > ctx.config.limits.maxPageSize) throw errors.invalidRequest([{ path: "limit", code: "out_of_range" }]);
  return size;
}

/** Opaque, URL-safe position in a list. It names a position only: the organization and every filter come from the request, never from it. */
export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined, check: (value: unknown) => T | undefined): T | undefined {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const checked = check(parsed);
    if (checked !== undefined) return checked;
  } catch {
    // fall through
  }
  throw new ApiError(400, "invalid_cursor", { issues: [{ path: "cursor", code: "pattern" }] });
}

/** Turns the `limit + 1` rows a repository returned into a page. */
export function toPage<T>(rows: T[], limit: number, cursorOf: (last: T) => unknown): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}

/** Runs `work` over `items` with at most `width` in flight, keeping the order of the results. */
export async function mapPool<T, R>(items: readonly T[], width: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
