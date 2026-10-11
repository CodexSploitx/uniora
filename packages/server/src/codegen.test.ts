import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateClientSource } from "./codegen.js";
import { allRoutes } from "./routes/index.js";

const COMMITTED = join(import.meta.dirname, "..", "..", "client", "src", "generated.ts");

describe("the client's generated surface", () => {
  it("has an operation for every route", () => {
    const source = generateClientSource();
    for (const route of allRoutes()) expect(source, route.id).toContain(`${JSON.stringify(route.id)}: {`);
  });

  it("matches the committed copy in packages/client (regenerate with UPDATE_DOCS=1)", () => {
    if (process.env.UPDATE_DOCS === "1") writeFileSync(COMMITTED, generateClientSource());
    expect(readFileSync(COMMITTED, "utf8")).toBe(generateClientSource());
  });
});
