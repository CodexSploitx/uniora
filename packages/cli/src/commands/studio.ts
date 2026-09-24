import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { parseArgs, UsageError, type OptionSpec, type ParsedFlags } from "../cli/args.js";
import { COMMON_SPEC, type CommonOptions } from "../cli/common.js";
import { loadConfig } from "../config/loader.js";
import { UnioraConfigError } from "../config/validate.js";

export const STUDIO_HOST = "127.0.0.1";
export const DEFAULT_STUDIO_PORT = 4321;

export interface StudioArgs {
  port?: number;
  readOnly: boolean;
  open: boolean;
}

export const STUDIO_SPEC: OptionSpec = { ...COMMON_SPEC, port: "string", "read-only": "boolean", "no-open": "boolean" };

/** Extrae los flags propios de Studio de un `parseArgs` ya hecho. Lanza `UsageError` si `--port` es inválido. */
export function studioArgsFromFlags(flags: ParsedFlags): StudioArgs {
  const args: StudioArgs = { readOnly: flags["read-only"] === true, open: flags["no-open"] !== true };
  if (flags.port !== undefined) {
    const port = Number(flags.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new UsageError("--port necesita un número entre 1024 y 65535.");
    }
    args.port = port;
  }
  return args;
}

/** Parseo manual de flags (sin dependencia de un parser de argumentos). Lanza `UsageError` con un mensaje claro si un flag es inválido. */
export function parseStudioArgs(argv: string[]): StudioArgs {
  return studioArgsFromFlags(parseArgs(argv, STUDIO_SPEC).flags);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, STUDIO_HOST);
  });
}

/** Primer puerto libre desde `start` (solo loopback). */
export async function findFreePort(start: number = DEFAULT_STUDIO_PORT, attempts = 20): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No se encontró un puerto libre entre ${start} y ${start + attempts - 1}. Usa --port.`);
}

export function generateLaunchToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Entorno con el que se lanza Studio. La connection string viaja por
 * variable de entorno (nunca por argv, donde `ps` la mostraría) y el token de
 * lanzamiento es aleatorio por ejecución.
 */
export function buildStudioEnv(
  base: NodeJS.ProcessEnv,
  options: { databaseUrl: string; token: string; port: number; readOnly: boolean; authProvider?: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NODE_ENV: "production",
    UNIORA_STUDIO_DATABASE_URL: options.databaseUrl,
    UNIORA_STUDIO_TOKEN: options.token,
    UNIORA_STUDIO_PORT: String(options.port),
    UNIORA_STUDIO_READ_ONLY: options.readOnly ? "1" : "0",
  };
  // Only a UI convenience (pre-fills the "owner provider" field) — never
  // validated further, since a host app may still use more than one auth
  // provider even when `auth.provider` names its main one.
  if (options.authProvider) env.UNIORA_STUDIO_AUTH_PROVIDER = options.authProvider;
  return env;
}

export function studioLaunchUrl(port: number, token: string): string {
  return `http://${STUDIO_HOST}:${port}/?token=${token}`;
}

/** Localiza Studio y comprueba que esté compilado. Lanza con un mensaje accionable si no. */
export function resolveStudio(): { dir: string; nextBin: string } {
  const require = createRequire(import.meta.url);
  let dir: string;
  try {
    dir = dirname(require.resolve("@uniora/studio/package.json"));
  } catch {
    throw new Error("No se encontró @uniora/studio. Instálalo junto a @uniora/cli.");
  }
  if (!existsSync(join(dir, ".next", "BUILD_ID"))) {
    throw new Error(
      "Studio no está compilado. Si trabajas en el monorepo de UNIORA: `pnpm --filter @uniora/studio build`. " +
        "Si lo instalaste desde npm, reinstala @uniora/studio (el paquete publicado ya incluye el build).",
    );
  }
  const nextBin = createRequire(join(dir, "package.json")).resolve("next/dist/bin/next");
  return { dir, nextBin };
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    /* sin navegador disponible: el usuario abre la URL impresa */
  }
}

/**
 * `npx uniora studio` (docs/PROYECT.md §21-22): Studio local, sin enviar datos
 * a ningún servidor de UNIORA. Solo escucha en loopback y exige un token de
 * lanzamiento aleatorio (la URL impresa lo incluye); nunca imprime la
 * connection string.
 */
export async function runStudio(
  args: StudioArgs,
  cwd: string = process.cwd(),
  options: CommonOptions = {},
): Promise<void> {
  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    console.error(`✗ ${error instanceof UnioraConfigError ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  let studio;
  let port;
  try {
    studio = resolveStudio();
    port = args.port ?? (await findFreePort());
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const token = generateLaunchToken();
  const url = studioLaunchUrl(port, token);

  const child = spawn(process.execPath, [studio.nextBin, "start", "-H", STUDIO_HOST, "-p", String(port)], {
    cwd: studio.dir,
    stdio: ["ignore", "inherit", "inherit"],
    env: buildStudioEnv(process.env, {
      databaseUrl: config.database.url,
      token,
      port,
      readOnly: args.readOnly,
      authProvider: config.auth?.provider,
    }),
  });

  const stop = () => child.kill("SIGTERM");
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`✓ UNIORA Studio en http://${STUDIO_HOST}:${port}${args.readOnly ? " (solo lectura)" : ""}`);
  console.log(`  Abre esta URL para desbloquearlo (el token cambia en cada ejecución):\n\n  ${url}\n`);
  console.log("  Ctrl+C para detenerlo.");
  if (args.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (code && code !== 0 && code !== 143) process.exitCode = code;
      resolve();
    });
    child.on("error", (error) => {
      console.error(`✗ No se pudo iniciar Studio: ${error.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}
