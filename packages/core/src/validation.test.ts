import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as validation from "./validation.js";
import * as root from "./index.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Runtime (non-type) module specifiers a source file imports or re-exports. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const [, , isType, , specifier, bare, dynamic] = match;
    if (isType) continue;
    // verbatimModuleSyntax keeps `import { type A } from "x"` as `import {} from "x"`, so only `import type` is skipped.
    found.push(specifier ?? bare ?? dynamic!);
  }
  return found;
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  if (seen.has(entry)) return seen;
  const specifiers = runtimeSpecifiers(readFileSync(entry, "utf8"));
  seen.set(entry, specifiers);
  for (const specifier of specifiers) {
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(entry), specifier.replace(/\.js$/, ".ts"));
    if (!existsSync(target)) throw new Error(`${entry} imports ${specifier}, which does not exist.`);
    walk(target, seen);
  }
  return seen;
}

describe("@uniora/core/validation", () => {
  it("never reaches a Node built-in or a package, so a browser bundle can import it", () => {
    const graph = walk(resolve(here, "validation.ts"));
    expect(graph.size).toBeGreaterThan(5);
    const offenders = [...graph].flatMap(([file, specifiers]) =>
      specifiers.filter((s) => !s.startsWith(".")).map((s) => `${file.slice(here.length + 1)} → ${s}`),
    );
    expect(offenders).toEqual([]);
  });

  it("exports the same functions as the root entry point (no divergent copies)", () => {
    for (const [name, value] of Object.entries(validation)) {
      expect((root as Record<string, unknown>)[name], name).toBe(value);
    }
  });

  it("validates with the rules the server enforces", () => {
    expect(validation.sanitizeOrganizationName("  Acme   Corp ")).toBe("Acme Corp");
    expect(validation.resolveOrganizationSlug("Acme Corp")).toBe("acme-corp");
    expect(() => validation.assertValidSlug("Not A Slug")).toThrow(validation.OrganizationError);
    expect(validation.resolveRoleKey("Account Manager")).toBe("account-manager");
    expect(() => validation.assertValidPermissionKey("")).toThrow(validation.PermissionError);
    expect(() => validation.assertValidFeatureKey("A B")).toThrow(validation.FeatureError);
  });

  it("is declared as a side-effect-free package with a subpath export", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8")) as {
      sideEffects?: unknown;
      exports: Record<string, unknown>;
    };
    expect(manifest.sideEffects).toBe(false);
    expect(manifest.exports["./validation"]).toEqual({
      types: "./dist/validation.d.ts",
      default: "./dist/validation.js",
    });
  });
});
