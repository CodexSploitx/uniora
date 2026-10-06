#!/usr/bin/env node
// Revisa lo que se va a publicar: `publint` valida package.json/exports contra los archivos reales y
// `attw` (Are The Types Wrong) valida que los tipos resuelvan para quien consume el paquete.
// Corre después de `pnpm -r build`. Solo los paquetes con `exports` (las librerías); la CLI y Studio no son librerías.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages", "packages/adapters", "packages/database"];
const failures = [];

for (const root of ROOTS) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, entry.name);
    const file = join(dir, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.private || !pkg.exports) continue;

    for (const [tool, args] of [
      ["publint", ["--strict"]],
      ["attw", ["--pack", ".", "--profile", "esm-only", "--no-emoji"]],
    ]) {
      const result = spawnSync("pnpm", ["exec", tool, ...args], { cwd: dir, encoding: "utf8" });
      const ok = result.status === 0;
      console.log(`${ok ? "✓" : "✗"} ${pkg.name} · ${tool}`);
      if (!ok) {
        console.log(result.stdout + result.stderr);
        failures.push(`${pkg.name} (${tool})`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`\nFallaron: ${failures.join(", ")}`);
  process.exit(1);
}
