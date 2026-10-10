import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./openapi.js";
import { allRoutes } from "./routes/index.js";

const COMMITTED = join(import.meta.dirname, "..", "..", "..", "guides", "openapi.json");
const render = (): string => `${JSON.stringify(buildOpenApiDocument({ version: "0.0.0-docs" }), null, 2)}\n`;

describe("the OpenAPI document", () => {
  it("is a valid OpenAPI 3.1 document", async () => {
    const result = await new Validator().validate(buildOpenApiDocument() as never);
    expect(result.errors ?? result.valid, JSON.stringify(result.errors)).toBe(true);
  });

  it("has an operation for every route and nothing else", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, { operationId: string }>> };
    const documented = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId));
    expect(documented.sort()).toEqual(allRoutes().map((route) => route.id).sort());
  });

  it("documents the scope, the actor and the error codes of each route", () => {
    const doc = buildOpenApiDocument() as { paths: Record<string, Record<string, Record<string, unknown>>> };
    for (const route of allRoutes()) {
      const path = route.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
      const operation = doc.paths[path]![route.method.toLowerCase()]!;
      expect(operation["x-uniora-scope"], route.id).toBe(route.scope);
      expect(operation["x-uniora-delegated"], route.id).toBe(route.delegated);
      const responses = operation.responses as Record<string, { description: string }>;
      const text = Object.values(responses).map((response) => response.description).join(" ");
      for (const code of route.errors) expect(text, `${route.id} documents ${code}`).toContain(`\`${code}\``);
      expect(responses["401"], route.id).toBeDefined();
      const names = ((operation.parameters as { name?: string; $ref?: string }[] | undefined) ?? []).map((parameter) => parameter.name ?? parameter.$ref);
      expect(names.includes("#/components/parameters/ActorSubject"), route.id).toBe(route.delegated);
    }
  });

  it("matches the committed copy in guides/openapi.json (regenerate with UPDATE_DOCS=1)", () => {
    if (process.env.UPDATE_DOCS === "1") writeFileSync(COMMITTED, render());
    expect(readFileSync(COMMITTED, "utf8")).toBe(render());
  });
});
