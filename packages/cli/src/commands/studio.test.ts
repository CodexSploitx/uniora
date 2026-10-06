import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { buildStudioEnv, writeLaunchPage, findFreePort, generateLaunchToken, parseStudioArgs, studioDatabaseUrl, studioLaunchUrl } from "./studio.js";

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

describe("Studio con SQLite", () => {
  it("buildStudioEnv indica el proveedor (postgresql por defecto)", () => {
    const base = { databaseUrl: "x", token: "t", port: 4321, readOnly: false };
    expect(buildStudioEnv({}, base).UNIORA_STUDIO_DATABASE_PROVIDER).toBe("postgresql");
    expect(buildStudioEnv({}, { ...base, databaseProvider: "sqlite" }).UNIORA_STUDIO_DATABASE_PROVIDER).toBe("sqlite");
  });

  it("studioDatabaseUrl resuelve la ruta SQLite relativa contra el proyecto (Studio corre en otro directorio) y no toca la de Postgres", () => {
    const cwd = resolve("/projects/app");
    expect(studioDatabaseUrl({ provider: "sqlite", url: "sqlite:./data/uniora.db" }, cwd)).toBe(`sqlite:${resolve(cwd, "data/uniora.db")}`);
    expect(studioDatabaseUrl({ provider: "postgresql", url: "postgresql://u:p@h/db" }, cwd)).toBe("postgresql://u:p@h/db");
  });
});

describe("writeLaunchPage (audit F-08)", () => {
  it("keeps the token out of the opener's argv: the page is private, forwards to the URL, and is removable", () => {
    const url = "http://127.0.0.1:4321/?token=abc&x=1";
    const page = writeLaunchPage(url);
    try {
      expect(page.path).not.toContain("abc");
      if (process.platform !== "win32") {
        expect(statSync(page.path).mode & 0o777).toBe(0o600);
        expect(statSync(dirname(page.path)).mode & 0o777).toBe(0o700);
      }
      const html = readFileSync(page.path, "utf8");
      expect(html).toContain("http://127.0.0.1:4321/?token=abc&amp;x=1");
    } finally {
      page.cleanup();
    }
    expect(existsSync(page.path)).toBe(false);
  });

  it("buildStudioEnv passes the operator through", () => {
    const env = buildStudioEnv({}, { databaseUrl: "postgres://x", token: "t", port: 4321, readOnly: false, operator: "ana" });
    expect(env.UNIORA_STUDIO_OPERATOR).toBe("ana");
  });
});
