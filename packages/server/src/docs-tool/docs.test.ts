import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allRoutes } from "../routes/index.js";
import { renderReference } from "./render.js";
import { runScenario } from "./run.js";

const COMMITTED = join(import.meta.dirname, "..", "..", "..", "..", "guides", "server-api.md");

describe("the API reference", () => {
  it("has an executed example for every operation, and the document matches the committed one (regenerate with UPDATE_DOCS=1)", async () => {
    const recorded = await runScenario();
    const covered = new Set(recorded.map((item) => item.route.id));
    expect(allRoutes().filter((route) => !covered.has(route.id)).map((route) => route.id)).toEqual([]);

    const document = renderReference(recorded, allRoutes());
    if (process.env.UPDATE_DOCS === "1") writeFileSync(COMMITTED, document);
    expect(readFileSync(COMMITTED, "utf8")).toBe(document);
    // And the same story told twice gives the same document: nothing in it depends on the moment it ran.
    expect(renderReference(await runScenario(), allRoutes())).toBe(document);
  });
});
