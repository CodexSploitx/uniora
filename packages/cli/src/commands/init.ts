import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emit } from "../cli/output.js";

const CONFIG_FILENAME = "uniora.config.mjs";
const ENV_EXAMPLE_FILENAME = ".env.example";
const GITIGNORE_FILENAME = ".gitignore";
const ENV_IGNORE_LINES = [".env", ".env.*.local"];

const CONFIG_TEMPLATE = `import { defineConfig } from "@uniora/cli";

export default defineConfig({
  database: {
    provider: "postgresql",
    // Nunca hardcodees esta URL: siempre debe venir de tu .env (ver .env.example).
    url: process.env.DATABASE_URL,
  },

  // auth: {
  //   provider: "supabase",
  // },
});
`;

const ENV_EXAMPLE_TEMPLATE = `# Copia este archivo a .env (nunca lo commitees) y ajusta los valores.
DATABASE_URL=postgresql://user:password@localhost:5432/database
`;

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
 * Añade `.env`/`.env.*.local` a `.gitignore` si faltan, sin tocar el resto
 * del archivo. Nunca elimina ni reemplaza líneas existentes.
 */
function ensureEnvIgnored(cwd: string): WriteResult {
  const gitignorePath = join(cwd, GITIGNORE_FILENAME);

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, ENV_IGNORE_LINES.join("\n") + "\n");
    return { path: gitignorePath, status: "created" };
  }

  const content = readFileSync(gitignorePath, "utf8");
  const lines = content.split("\n").map((line) => line.trim());
  const missing = ENV_IGNORE_LINES.filter((line) => !lines.includes(line));

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
export function runInit(cwd: string = process.cwd(), options: { force?: boolean; json?: boolean } = {}): void {
  const force = options.force ?? false;

  const configResult = writeIfAbsent(join(cwd, CONFIG_FILENAME), CONFIG_TEMPLATE, force);
  const envExampleResult = writeIfAbsent(join(cwd, ENV_EXAMPLE_FILENAME), ENV_EXAMPLE_TEMPLATE, force);
  const gitignoreResult = ensureEnvIgnored(cwd);
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
