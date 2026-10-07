import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SqlMigration {
  readonly id: string;
  readonly sql: string;
}

/** The leading `/** … *\/` block of a migration's TypeScript file, as plain text lines. */
function leadingComment(source: string): string[] {
  const match = /^\s*\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!match) return [];
  return match[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .filter((line, index, all) => !(line === "" && (index === 0 || index === all.length - 1)));
}

/**
 * The text of the `.sql` file for one migration: a commented header (what it does, taken from the doc comment of its
 * TypeScript source) followed by the exact SQL the migrator runs. Deterministic, so a test can compare it with the
 * committed file.
 */
export function renderSqlFile(adapter: string, migration: SqlMigration, source: string): string {
  const doc = leadingComment(source);
  const header = [
    `-- ${adapter} migration ${migration.id}`,
    `-- Generated from src/migrations/${migration.id}.ts; do not edit. Regenerate with \`pnpm sql:export\`.`,
    ...(doc.length > 0 ? ["--", ...doc.map((line) => (line === "" ? "--" : `-- ${line}`))] : []),
  ];
  return `${header.join("\n")}\n\n${migration.sql.trim()}\n`;
}

/**
 * Compares `dir` with what `migrations` render to (or, with `update`, rewrites it, removing stale files).
 * Returns the problems found; empty means the folder is in sync.
 */
export function syncSqlFiles(options: {
  adapter: string;
  dir: string;
  sourceDir: string;
  migrations: readonly SqlMigration[];
  update?: boolean;
}): string[] {
  const { adapter, dir, sourceDir, migrations, update = false } = options;
  const expected = new Map(
    migrations.map((migration) => [`${migration.id}.sql`, renderSqlFile(adapter, migration, readFileSync(join(sourceDir, `${migration.id}.ts`), "utf8"))]),
  );
  if (update) {
    mkdirSync(dir, { recursive: true });
    for (const file of existsSync(dir) ? readdirSync(dir) : []) if (file.endsWith(".sql") && !expected.has(file)) rmSync(join(dir, file));
    for (const [file, text] of expected) writeFileSync(join(dir, file), text);
  }
  const problems: string[] = [];
  const present = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith(".sql")) : [];
  for (const [file, text] of expected) {
    if (!present.includes(file)) problems.push(`missing ${file}`);
    else if (readFileSync(join(dir, file), "utf8") !== text) problems.push(`out of date ${file}`);
  }
  for (const file of present) if (!expected.has(file)) problems.push(`stale ${file}`);
  return problems;
}
