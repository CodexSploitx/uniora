/** Error de uso del CLI (flag desconocido, valor faltante, combinación inválida). Sale con código 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type OptionKind = "boolean" | "string";
export type OptionSpec = Readonly<Record<string, OptionKind>>;
export type ParsedFlags = Record<string, string | boolean | undefined>;

export interface ParsedArgs {
  readonly flags: ParsedFlags;
  readonly positionals: string[];
}

/**
 * Parseo manual de flags (sin dependencia de commander/yargs — skill §33).
 * Estricto a propósito: un flag desconocido, repetido o sin valor **falla**,
 * nunca se ignora ni se resuelve "el último gana" (parameter pollution, skill
 * §8.8): `--env staging --env production` sería ambiguo sobre qué base de
 * datos se toca.
 *
 * Acepta `--flag`, `--flag valor` y `--flag=valor`. `spec` mapea el nombre
 * largo (sin `--`) a su tipo.
 */
export function parseArgs(argv: readonly string[], spec: OptionSpec): ParsedArgs {
  const flags: ParsedFlags = {};
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;

    if (arg === "-h") {
      set(flags, "help", true, arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`Opción desconocida: "${arg}".`);
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    const name = arg.slice(2, equals === -1 ? undefined : equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (!kind) throw new UsageError(`Opción desconocida: "--${name}".`);

    if (kind === "boolean") {
      if (inline !== undefined) throw new UsageError(`--${name} no acepta un valor.`);
      set(flags, name, true, `--${name}`);
      continue;
    }

    const value = inline ?? argv[++index];
    if (value === undefined || value === "" || (inline === undefined && value.startsWith("-"))) {
      throw new UsageError(`--${name} necesita un valor.`);
    }
    set(flags, name, value, `--${name}`);
  }

  return { flags, positionals };
}

function set(flags: ParsedFlags, name: string, value: string | boolean, label: string): void {
  if (Object.hasOwn(flags, name)) throw new UsageError(`${label} se indicó más de una vez.`);
  flags[name] = value;
}
