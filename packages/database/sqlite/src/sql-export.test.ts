import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { syncSqlFiles } from "@uniora/storage-conformance";
import { listMigrations } from "./migrate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The committed `sql/*.sql` files are what teams that apply SQL with their own tooling (Supabase CLI, Flyway, Atlas…) use.
// They must say exactly what `applyMigrations` runs. After adding or changing a migration: `pnpm sql:export`.
describe("@uniora/sqlite — sql/*.sql files", () => {
  it("match the migrations the migrator runs", () => {
    const problems = syncSqlFiles({
      adapter: "@uniora/sqlite",
      dir: join(root, "sql"),
      sourceDir: join(root, "src", "migrations"),
      migrations: listMigrations(),
      update: process.env.UPDATE_SQL === "1",
    });
    expect(problems, "run `pnpm sql:export` to regenerate the sql/ folder").toEqual([]);
  });

  it("every file starts with its header and contains the exact SQL the migrator runs", () => {
    for (const migration of listMigrations()) {
      const text = readFileSync(join(root, "sql", `${migration.id}.sql`), "utf8");
      expect(text.startsWith(`-- @uniora/sqlite migration ${migration.id}\n`)).toBe(true);
      expect(text.endsWith(`${migration.sql.trim()}\n`)).toBe(true);
    }
  });
});
