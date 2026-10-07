# Quotas per organization (entitlements)

How many seats, vehicles or monthly reports may an organization use? UNIORA doesn't know your plans or licences: **you decide each
organization's limit** (usually from your own billing data) and UNIORA counts the usage and refuses what doesn't fit, atomically.

```ts
// Once, at startup: what can be limited, how often it resets, and what an organization gets by default.
await storage.entitlements.define({ key: "seats", name: "Seats", period: "lifetime", defaultLimit: 3 });
await storage.entitlements.define({ key: "reports_per_month", period: "monthly", defaultLimit: 20 });

// When your billing says an organization got more (or "unlimited" with null):
await storage.entitlements.setLimit(organizationId, "seats", 25);
await storage.entitlements.clearLimit(organizationId, "seats"); // back to the default

// Before doing the thing:
const taken = await storage.entitlements.consume(organizationId, "reports_per_month");
if (!taken.allowed) return reply(402, `Monthly reports used: ${taken.used}/${taken.limit}`);

// When a gauge goes down (a seat is freed):
await storage.entitlements.release(organizationId, "seats");
```

- **`consume` is check-and-take in one atomic step** (one upsert in Postgres, one `begin immediate` in SQLite): twenty concurrent requests against a limit of five get exactly five.
- **Periods** are UTC calendar windows: `daily`, `monthly`, or `lifetime` (never resets; use it for gauges such as seats together with `release`). `get` / `list` report `used`, `remaining`, `windowStart` and `windowEnd`.
- **Limits**: a whole number, 0 or more, or `null` for unlimited (unlimited still counts, so you can report usage). Without an override of its own an organization follows the definition's `defaultLimit`.
- **Audit**: `define`, `undefine`, `setLimit` and `clearLimit` are recorded by `createAuditedStorage` (`entitlement.defined`, `entitlement.removed`, `entitlement.limit_changed`, `entitlement.limit_cleared`); `consume` and `release` are not, they are far too frequent.
- **Not a gate by itself**: UNIORA doesn't block anything on its own; `consume` tells you, and you return the error you want. For "is this feature on at all?" keep using features.

Postgres migration `0027`, SQLite `0012`. Usage rows are small (one per organization, entitlement and window); delete the old ones with your own housekeeping job if you use `daily` for years.
