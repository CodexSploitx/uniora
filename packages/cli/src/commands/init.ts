import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../cli/output.js";
import type { DatabaseProvider } from "../database/types.js";

const CONFIG_FILENAME = "uniora.config.mjs";
const ENV_EXAMPLE_FILENAME = ".env.example";
const GITIGNORE_FILENAME = ".gitignore";
const ENV_IGNORE_LINES = [".env", ".env.*.local"];
/** El archivo SQLite guarda los datos de autorización: tampoco debe acabar en git (incluye `-wal`/`-shm`). */
const SQLITE_IGNORE_LINES = ["uniora.db*"];

const URL_COMMENT: Record<DatabaseProvider, string> = {
  postgresql: "    // Nunca hardcodees esta URL: siempre debe venir de tu .env (ver .env.example).",
  sqlite:
    "    // sqlite:<ruta> — relativa a este proyecto, o absoluta. Viene de tu .env (ver .env.example).",
};

function configTemplate(provider: DatabaseProvider): string {
  return `import { defineConfig } from "@uniora/cli";

export default defineConfig({
  database: {
    provider: "${provider}",
${URL_COMMENT[provider]}
    url: process.env.DATABASE_URL,
  },

  // auth: {
  //   provider: "supabase",
  // },
});
`;
}

const ENV_EXAMPLE_URL: Record<DatabaseProvider, string> = {
  postgresql: "postgresql://user:password@localhost:5432/database",
  sqlite: "sqlite:./uniora.db",
};

function envExampleTemplate(provider: DatabaseProvider): string {
  return `# Copia este archivo a .env (nunca lo commitees) y ajusta los valores.
DATABASE_URL=${ENV_EXAMPLE_URL[provider]}
`;
}

interface WriteResult {
  readonly path: string;
  readonly status: "created" | "overwritten" | "skipped";
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Crea `path` solo si no existe (`flag: "wx"` lo hace atómico a nivel de SO —
 * sin ventana entre "verificar si existe" y "escribir" — en vez de un
 * `existsSync` + `writeFileSync` separados). Con `force`, sobrescribe.
 *
 * Nunca sobrescribir por defecto: un `init` accidental sobre un proyecto ya
 * configurado no debe destruir la config del desarrollador (skill §58 — las
 * mutaciones que pueden ser destructivas deben requerir opt-in explícito).
 */
function writeIfAbsent(path: string, content: string, force: boolean): WriteResult {
  if (force) {
    const existed = existsSync(path);
    writeFileSync(path, content);
    return { path, status: existed ? "overwritten" : "created" };
  }

  try {
    writeFileSync(path, content, { flag: "wx" });
    return { path, status: "created" };
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      return { path, status: "skipped" };
    }
    throw error;
  }
}

/**
 * Añade `.env`/`.env.*.local` (y, con SQLite, el archivo de la base) a
 * `.gitignore` si faltan, sin tocar el resto del archivo. Nunca elimina ni reemplaza líneas existentes.
 */
function ensureEnvIgnored(cwd: string, extraLines: readonly string[]): WriteResult {
  const wanted = [...ENV_IGNORE_LINES, ...extraLines];
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, wanted.join("\n") + "\n");
    return { path: gitignorePath, status: "created" };
  }

  const content = readFileSync(gitignorePath, "utf8");
  const lines = content.split("\n").map((line) => line.trim());
  const missing = wanted.filter((line) => !lines.includes(line));

  if (missing.length === 0) {
    return { path: gitignorePath, status: "skipped" };
  }

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, content + separator + missing.join("\n") + "\n");
  return { path: gitignorePath, status: "overwritten" };
}

const STATUS_LABEL: Record<WriteResult["status"], string> = {
  created: "creado",
  overwritten: "actualizado",
  skipped: "ya existía, sin cambios",
};

/**
 * `npx uniora init` (docs/PROYECT.md §19). Nunca escribe secretos reales:
 * solo plantillas con placeholders y `process.env.DATABASE_URL` — el
 * desarrollador copia `.env.example` a `.env` y pone sus propios valores.
 */
export function runInit(
  cwd: string = process.cwd(),
  options: { force?: boolean; json?: boolean; provider?: DatabaseProvider } = {},
): void {
  const force = options.force ?? false;
  const provider = options.provider ?? "postgresql";

  const configResult = writeIfAbsent(join(cwd, CONFIG_FILENAME), configTemplate(provider), force);
  const envExampleResult = writeIfAbsent(join(cwd, ENV_EXAMPLE_FILENAME), envExampleTemplate(provider), force);
  const gitignoreResult = ensureEnvIgnored(cwd, provider === "sqlite" ? SQLITE_IGNORE_LINES : []);
  const results = [configResult, envExampleResult, gitignoreResult];

  if (options.json) {
    emit(
      {
        command: "init",
        checks: results.map((result) => ({ name: result.path, severity: "ok" as const, message: STATUS_LABEL[result.status] })),
        data: { files: results.map((result) => ({ path: result.path, status: result.status })) },
      },
      true,
    );
    return;
  }

  for (const result of results) {
    const marker = result.status === "skipped" ? "•" : "✓";
    console.log(`${marker} ${result.path} (${STATUS_LABEL[result.status]})`);
  }

  if (configResult.status === "skipped" || envExampleResult.status === "skipped") {
    console.log('\nAlgunos archivos ya existían y no se modificaron. Usa "uniora init --force" para sobrescribirlos.');
  }

  console.log('\nSiguiente paso: copia .env.example a .env, ajusta DATABASE_URL y corre "uniora check".');
}
