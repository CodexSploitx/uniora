import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { buildStudioEnv, findFreePort, generateLaunchToken, parseStudioArgs, studioLaunchUrl } from "./studio.js";

describe("parseStudioArgs", () => {
  it("usa valores por defecto sin flags", () => {
    expect(parseStudioArgs([])).toEqual({ readOnly: false, open: true });
  });

  it("acepta --read-only, --no-open y --port", () => {
    expect(parseStudioArgs(["--read-only", "--no-open", "--port", "5000"])).toEqual({
      readOnly: true,
      open: false,
      port: 5000,
    });
  });

  it("rechaza un puerto inválido o fuera de rango", () => {
    expect(() => parseStudioArgs(["--port"])).toThrow(/--port/);
    expect(() => parseStudioArgs(["--port", "abc"])).toThrow(/--port/);
    expect(() => parseStudioArgs(["--port", "80"])).toThrow(/--port/);
    expect(() => parseStudioArgs(["--port", "70000"])).toThrow(/--port/);
  });

  it("rechaza flags desconocidos (nunca los ignora en silencio)", () => {
    expect(() => parseStudioArgs(["--host", "0.0.0.0"])).toThrow(/desconocida/);
  });
});

describe("generateLaunchToken", () => {
  it("genera tokens hex de 256 bits, distintos en cada llamada", () => {
    const a = generateLaunchToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateLaunchToken()).not.toBe(a);
  });
});

describe("buildStudioEnv", () => {
  it("pasa la connection string, el token y el modo solo por entorno", () => {
    const env = buildStudioEnv({ PATH: "/bin" }, { databaseUrl: "postgres://u:p@h/db", token: "t", port: 4321, readOnly: true });
    expect(env).toMatchObject({
      PATH: "/bin",
      NODE_ENV: "production",
      UNIORA_STUDIO_DATABASE_URL: "postgres://u:p@h/db",
      UNIORA_STUDIO_TOKEN: "t",
      UNIORA_STUDIO_PORT: "4321",
      UNIORA_STUDIO_READ_ONLY: "1",
    });
    expect(env.UNIORA_STUDIO_AUTH_PROVIDER).toBeUndefined();
  });

  it("pasa auth.provider de la config cuando está presente (pre-llena el owner/member provider en Studio)", () => {
    const env = buildStudioEnv({}, { databaseUrl: "postgres://u:p@h/db", token: "t", port: 4321, readOnly: false, authProvider: "supabase" });
    expect(env.UNIORA_STUDIO_AUTH_PROVIDER).toBe("supabase");
  });
});

describe("studioLaunchUrl", () => {
  it("apunta solo a loopback e incluye el token", () => {
    expect(studioLaunchUrl(4321, "abc")).toBe("http://127.0.0.1:4321/?token=abc");
  });
});

describe("findFreePort", () => {
  it("salta un puerto ocupado", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const busy = (server.address() as { port: number }).port;
    try {
      const free = await findFreePort(busy, 5);
      expect(free).toBeGreaterThan(busy);
    } finally {
      server.close();
    }
  });
});
