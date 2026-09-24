import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "./args.js";

const spec = { json: "boolean", env: "string", port: "string" } as const;

describe("parseArgs", () => {
  it("parsea booleanos, valores separados y --flag=valor", () => {
    expect(parseArgs(["--json", "--env", "production", "--port=5000"], spec).flags).toEqual({
      json: true,
      env: "production",
      port: "5000",
    });
  });

  it("rechaza flags desconocidos (nunca los ignora en silencio)", () => {
    expect(() => parseArgs(["--host", "0.0.0.0"], spec)).toThrow(UsageError);
    expect(() => parseArgs(["-x"], spec)).toThrow(/desconocida/);
  });

  it("rechaza un flag repetido en vez de dejar que 'gane el último' (parameter pollution)", () => {
    expect(() => parseArgs(["--env", "staging", "--env", "production"], spec)).toThrow(/más de una vez/);
    expect(() => parseArgs(["--json", "--json"], spec)).toThrow(/más de una vez/);
  });

  it("rechaza un valor faltante, vacío, o que en realidad es otro flag", () => {
    expect(() => parseArgs(["--env"], spec)).toThrow(/necesita un valor/);
    expect(() => parseArgs(["--env="], spec)).toThrow(/necesita un valor/);
    expect(() => parseArgs(["--env", "--json"], spec)).toThrow(/necesita un valor/);
  });

  it("rechaza un valor en un flag booleano", () => {
    expect(() => parseArgs(["--json=1"], spec)).toThrow(/no acepta un valor/);
  });

  it("no confunde nombres heredados de Object.prototype con flags válidos", () => {
    expect(() => parseArgs(["--constructor"], spec)).toThrow(/desconocida/);
    expect(() => parseArgs(["--__proto__=x"], spec)).toThrow(/desconocida/);
  });

  it("devuelve los posicionales aparte y traduce -h a help", () => {
    const parsed = parseArgs(["algo", "-h"], spec);
    expect(parsed.positionals).toEqual(["algo"]);
    expect(parsed.flags.help).toBe(true);
  });
});
