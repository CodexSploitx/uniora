import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A route can read through `ctx.config.storage`, but a WRITE must go through `ctx.delegated()` (the guarded storage, with the
 * audit context) or an application-call helper. This reads the route sources and fails on a write made with the plain storage.
 */
describe("route sources", () => {
  const dir = join(import.meta.dirname, "routes");
  const files = readdirSync(dir).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
  const WRITE = /config\.storage\b[^;]*?\.(create|createOwnerRole|update|delete|remove|assign\w*|unassign\w*|grant\w*|revoke\w*|set\w*|block|suspend|unblock|enable|disable|register|unregister|record|transaction|link|rotate\w*|accept|clone|rename)\s*\(/s;

  it.each(files)("%s never writes through the plain storage", (file) => {
    expect(readFileSync(join(dir, file), "utf8")).not.toMatch(WRITE);
  });
});
