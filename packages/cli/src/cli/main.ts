import { createRequire } from "node:module";
import { runCheck } from "../commands/check.js";
import { runDoctor } from "../commands/doctor.js";
import { runInit } from "../commands/init.js";
import { runMigrate } from "../commands/migrate.js";
import { runStudio, STUDIO_SPEC, studioArgsFromFlags } from "../commands/studio.js";
import { parseArgs, UsageError, type OptionSpec } from "./args.js";
import { commonFromFlags, JSON_SPEC } from "./common.js";

/** Códigos de salida: 0 = ok · 1 = el comando corrió y algo falló · 2 = uso incorrecto (flag/comando inválido). */
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const COMMON_HELP = `Opciones comunes:
  --config <ruta>   Archivo de configuración (.mjs/.js) en vez de uniora.config.mjs
  --env <nombre>    Carga .env.<nombre> (y solo ese) en vez de .env, p. ej. --env production
  --json            Salida JSON única en stdout (para CI); no disponible en studio
  -h, --help        Muestra esta ayuda`;

interface CommandDef {
  readonly summary: string;
  readonly usage: string;
  readonly details: string;
  readonly spec: OptionSpec;
}

const COMMANDS: Record<string, CommandDef> = {
  init: {
    summary: "Crea uniora.config.mjs y .env.example en el proyecto actual",
    usage: "uniora init [--force] [--json]",
    details: "  --force   Sobrescribe archivos existentes (por defecto nunca los toca)",
    spec: { help: "boolean", json: "boolean", force: "boolean" },
  },
  check: {
    summary: "Valida la configuración y la conexión a la base de datos",
    usage: "uniora check [--config <ruta>] [--env <nombre>] [--json]",
    details: "",
    spec: JSON_SPEC,
  },
  migrate: {
    summary: "Aplica las migraciones de UNIORA (registradas en uniora.schema_migrations)",
    usage: "uniora migrate [--status | --dry-run] [--config <ruta>] [--env <nombre>] [--json]",
    details: `  --status    Solo reporta aplicadas/pendientes. Sale con 1 si hay pendientes o modificadas (gate de CI)
  --dry-run   Muestra qué aplicaría "migrate" sin tocar la base`,
    spec: { ...JSON_SPEC, status: "boolean", "dry-run": "boolean" },
  },
  doctor: {
    summary: "Diagnóstico profundo (runtime, config, conexión, versión de PostgreSQL, migraciones, owners, Studio)",
    usage: "uniora doctor [--config <ruta>] [--env <nombre>] [--json]",
    details: "",
    spec: JSON_SPEC,
  },
  studio: {
    summary: "Abre UNIORA Studio en local (solo 127.0.0.1, con token por ejecución)",
    usage: "uniora studio [--port N] [--read-only] [--no-open] [--config <ruta>] [--env <nombre>]",
    details: `  --port N      Puerto (1024-65535); por defecto el primero libre desde 4321
  --read-only   Studio rechaza toda mutación
  --no-open     No abre el navegador`,
    spec: STUDIO_SPEC,
  },
};

function version(): string {
  // Desde src/cli/ o dist/cli/, `../../package.json` es el de @uniora/cli.
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  return pkg.version;
}

function globalHelp(): string {
  const lines = Object.entries(COMMANDS).map(([name, def]) => `  ${name.padEnd(8)} ${def.summary}`);
  return `Uso: uniora <comando> [opciones]

Comandos:
${lines.join("\n")}

Opciones globales:
  -v, --version     Muestra la versión
  -h, --help        Muestra esta ayuda (también: uniora <comando> --help)

Códigos de salida: 0 = ok · 1 = falló algo · 2 = uso incorrecto

${COMMON_HELP}
`;
}

function commandHelp(name: string): string {
  const def = COMMANDS[name] as CommandDef;
  return `${def.summary}\n\nUso: ${def.usage}\n${def.details ? `\n${def.details}\n` : ""}\n${COMMON_HELP}\n`;
}

/**
 * Punto de entrada del CLI, separado de `bin.ts` para poder probarlo sin
 * lanzar un proceso. Devuelve normalmente; los resultados se comunican por
 * `process.exitCode` (0/1/2).
 */
export async function runCli(argv: readonly string[], cwd: string = process.cwd()): Promise<void> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(globalHelp());
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(version());
    return;
  }

  const json = rest.includes("--json");
  try {
    if (!Object.hasOwn(COMMANDS, command)) {
      throw new UsageError(`Comando desconocido: "${command}".`);
    }
    const def = COMMANDS[command] as CommandDef;
    const { flags, positionals } = parseArgs(rest, def.spec);

    if (positionals.length > 0) throw new UsageError(`"${command}" no acepta argumentos posicionales ("${positionals[0]}").`);
    if (flags.help) {
      console.log(commandHelp(command));
      return;
    }

    switch (command) {
      case "init":
        runInit(cwd, { force: flags.force === true, json: flags.json === true });
        return;
      case "check":
        await runCheck(cwd, commonFromFlags(flags));
        return;
      case "migrate":
        if (flags.status && flags["dry-run"]) throw new UsageError("--status y --dry-run son excluyentes.");
        await runMigrate(cwd, { ...commonFromFlags(flags), status: flags.status === true, dryRun: flags["dry-run"] === true });
        return;
      case "doctor":
        await runDoctor(cwd, commonFromFlags(flags));
        return;
      case "studio":
        await runStudio(studioArgsFromFlags(flags), cwd, commonFromFlags(flags));
        return;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      if (json) console.log(JSON.stringify({ ok: false, error: error.message }));
      else console.error(`✗ ${error.message}\n\nEjecuta "uniora --help" para ver el uso.`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    throw error;
  }
}
