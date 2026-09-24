#!/usr/bin/env node
// Guard de release: falla si los paquetes publicables no están listos o no coinciden.
//   node scripts/check-release.mjs            → comprobaciones de consistencia
//   node scripts/check-release.mjs v0.1.0     → además exige que la versión coincida con el tag
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages", "packages/adapters", "packages/database", "apps"];
const problems = [];
const packages = [];

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const dir = join(root, entry.name);
    const file = join(dir, "package.json");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    if (pkg.private) continue; // p. ej. apps/playground
    packages.push({ dir, pkg });
  }
}

if (packages.length === 0) problems.push("No se encontró ningún paquete publicable.");

const versions = new Set(packages.map(({ pkg }) => pkg.version));
if (versions.size > 1) {
  problems.push(`Las versiones no coinciden (release en lockstep): ${[...versions].join(", ")}`);
}

const tag = process.argv[2];
if (tag) {
  const expected = tag.replace(/^v/, "");
  for (const { pkg } of packages) {
    if (pkg.version !== expected) problems.push(`${pkg.name}@${pkg.version} no coincide con el tag ${tag}`);
  }
}

for (const { dir, pkg } of packages) {
  const at = `${pkg.name} (${dir})`;
  if (pkg.license !== "PolyForm-Shield-1.0.0") problems.push(`${at}: license debe ser PolyForm-Shield-1.0.0`);
  if (!existsSync(join(dir, "LICENSE"))) problems.push(`${at}: falta LICENSE dentro del paquete`);
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    problems.push(`${at}: falta "files" (sin él npm respeta .gitignore y excluye dist/)`);
  }
  if (!pkg.scripts?.prepack) problems.push(`${at}: falta "prepack" (el tarball debe llevar un build fresco)`);
  if (pkg.publishConfig?.access !== "public") problems.push(`${at}: falta publishConfig.access = "public" (paquete con scope)`);
  if (!pkg.repository?.url) problems.push(`${at}: falta repository (necesario para el provenance)`);
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (name.startsWith("@uniora/") && range !== "workspace:^") {
        problems.push(`${at}: ${section}.${name} = "${range}" (debe ser "workspace:^"; pnpm lo convierte al publicar)`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ ${problems.length} problema(s) de release:\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`✓ ${packages.length} paquetes publicables consistentes (${[...versions][0]}): ${packages.map(({ pkg }) => pkg.name).join(", ")}`);
