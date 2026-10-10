import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { userInfo } from "node:os";
import { API_SCOPE_LIST, ApiCredentialError, createApiCredentialService } from "@uniora/core";
import type { ApiClient, ApiCredentialService, ApiKey, ApiScope } from "@uniora/core";
import { createUnioraServer } from "@uniora/server";
import type { RunningServer } from "@uniora/server";
import { UsageError, type OptionSpec, type ParsedFlags } from "../cli/args.js";
import { JSON_SPEC, type CommonOptions } from "../cli/common.js";
import { emit, failReport, type CheckResult, type Report } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import { openDriver } from "../database/open.js";
import type { DatabaseDriver } from "../database/types.js";

export const SERVER_SPEC: OptionSpec = {
  ...JSON_SPEC,
  name: "string",
  scopes: "string",
  orgs: "string",
  client: "string",
  "expires-in-days": "string",
  host: "string",
  port: "string",
  "default-provider": "string",
  "trusted-proxy-hops": "string",
  "tls-key": "string",
  "tls-cert": "string",
  "behind-tls-proxy": "boolean",
  "read-only": "boolean",
};

export interface ServerOptions extends CommonOptions {
  readonly name?: string;
  readonly scopes?: string;
  readonly orgs?: string;
  readonly client?: string;
  readonly expiresInDays?: string;
  readonly host?: string;
  readonly port?: string;
  readonly defaultProvider?: string;
  readonly trustedProxyHops?: string;
  readonly tlsKey?: string;
  readonly tlsCert?: string;
  readonly behindTlsProxy?: boolean;
  readonly readOnly?: boolean;
  /** Avisa cuando `start` ya escucha (para pruebas y para quien lo embeba). */
  readonly onStarted?: (running: RunningServer) => void;
  /** Cierra `start` igual que SIGINT/SIGTERM. */
  readonly stop?: AbortSignal;
}

export function serverOptionsFromFlags(flags: ParsedFlags, common: CommonOptions): ServerOptions {
  return {
    ...common,
    name: flags.name as string | undefined,
    scopes: flags.scopes as string | undefined,
    orgs: flags.orgs as string | undefined,
    client: flags.client as string | undefined,
    expiresInDays: flags["expires-in-days"] as string | undefined,
    host: flags.host as string | undefined,
    port: flags.port as string | undefined,
    defaultProvider: flags["default-provider"] as string | undefined,
    trustedProxyHops: flags["trusted-proxy-hops"] as string | undefined,
    tlsKey: flags["tls-key"] as string | undefined,
    tlsCert: flags["tls-cert"] as string | undefined,
    behindTlsProxy: flags["behind-tls-proxy"] === true,
    readOnly: flags["read-only"] === true,
  };
}

const CLIENT_ACTIONS = ["create", "update", "list", "show", "disable", "enable"] as const;
const KEY_ACTIONS = ["create", "revoke"] as const;
const USAGE = "Uso: uniora server <clients create|update|list|show|disable|enable | keys create|revoke | start>";

/** Quien firma los cambios en el audit log. `uniora-cli` es una etiqueta reservada: ningún usuario final puede llevarla. */
function operator(): { provider: string; subject: string } {
  let name = "unknown";
  try {
    name = userInfo().username || name;
  } catch {
    // Sin usuario de sistema resoluble (contenedores raros): queda como "uniora-cli:unknown".
  }
  return { provider: "uniora-cli", subject: name };
}

function list(text: string, flag: string): string[] {
  const items = text.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) throw new UsageError(`${flag} tiene un elemento vacío: usa valores separados por comas, sin espacios sobrantes.`);
  return items;
}

function parseScopes(text: string): ApiScope[] {
  const scopes = list(text, "--scopes");
  const unknown = scopes.find((scope) => !(API_SCOPE_LIST as readonly string[]).includes(scope));
  if (unknown) throw new UsageError(`--scopes: "${unknown}" no existe. Disponibles: ${API_SCOPE_LIST.join(", ")}.`);
  return scopes as ApiScope[];
}

function parseOrgs(text: string): "*" | string[] {
  if (text === "*") return "*";
  const orgs = list(text, "--orgs");
  if (orgs.includes("*")) throw new UsageError('--orgs: "*" va solo (todas las organizaciones) o se listan ids concretos, no ambos.');
  return orgs;
}

function describeClient(client: ApiClient, keys?: readonly ApiKey[]): Record<string, unknown> {
  return {
    id: client.id,
    name: client.name,
    status: client.status,
    scopes: client.scopes,
    organizations: client.organizations,
    version: client.version,
    createdAt: client.createdAt.toISOString(),
    ...(keys
      ? {
          keys: keys.map((key) => ({
            id: key.id,
            hint: key.hint,
            status: key.revokedAt ? "revoked" : key.expiresAt && key.expiresAt.getTime() <= Date.now() ? "expired" : "active",
            createdAt: key.createdAt.toISOString(),
            ...(key.expiresAt ? { expiresAt: key.expiresAt.toISOString() } : {}),
            ...(key.lastUsedAt ? { lastUsedAt: key.lastUsedAt.toISOString() } : {}),
          })),
        }
      : {}),
  };
}

const orgsText = (client: ApiClient): string => (client.organizations === "*" ? "todas" : `${client.organizations.length} organización(es)`);

async function resolveClient(service: ApiCredentialService, reference: string): Promise<ApiClient> {
  const direct = await service.getClient(reference);
  if (direct) return direct;
  const needle = reference.toLowerCase();
  const byName = (await service.listClients({ limit: 200 })).find((client) => client.name.toLowerCase() === needle);
  if (byName) return byName;
  throw new ApiCredentialError(`No hay ningún cliente con id o nombre "${reference}".`, "api_client_not_found");
}

/**
 * `uniora server clients|keys ...`: los mismos cambios que Studio, para automatización y para el primer arranque.
 * Hablan directo con la base (la raíz de confianza); no existe ninguna ruta HTTP que cree o cambie credenciales.
 * Una clave nueva se imprime UNA vez: no se guarda en claro, no se puede recuperar.
 */
export async function runServer(args: readonly string[], cwd: string = process.cwd(), options: ServerOptions = {}): Promise<void> {
  const json = options.json === true;
  const [group, action, reference] = args;
  if (group === "start") {
    if (action !== undefined) throw new UsageError(`"server start" no acepta argumentos ("${action}").`);
    return runServerStart(cwd, options);
  }
  if (group !== "clients" && group !== "keys") throw new UsageError(`${USAGE}${group ? ` ("${group}" no existe)` : ""}.`);
  const actions: readonly string[] = group === "clients" ? CLIENT_ACTIONS : KEY_ACTIONS;
  if (action === undefined || !actions.includes(action)) throw new UsageError(`${USAGE}${action ? ` ("${group} ${action}" no existe)` : ""}.`);
  const command = `server ${group} ${action}`;

  // Todo se valida antes de tocar la base.
  const needsReference = (group === "clients" && ["update", "show", "disable", "enable"].includes(action)) || (group === "keys" && action === "revoke");
  if (needsReference && reference === undefined) throw new UsageError(`${command} necesita ${group === "keys" ? "el id de la clave" : "el id o el nombre del cliente"}.`);
  if (!needsReference && reference !== undefined) throw new UsageError(`${command} no acepta argumentos ("${reference}").`);
  const onlyFor = (flag: string, present: unknown, valid: boolean) => {
    if (present !== undefined && !valid) throw new UsageError(`--${flag} no se usa con ${command}.`);
  };
  const creating = group === "clients" && action === "create";
  const updating = group === "clients" && action === "update";
  onlyFor("name", options.name, creating || updating);
  onlyFor("scopes", options.scopes, creating || updating);
  onlyFor("orgs", options.orgs, creating || updating);
  onlyFor("client", options.client, group === "keys" && action === "create");
  onlyFor("expires-in-days", options.expiresInDays, group === "keys" && action === "create");
  for (const [flag, value] of [["host", options.host], ["port", options.port], ["default-provider", options.defaultProvider], ["trusted-proxy-hops", options.trustedProxyHops], ["tls-key", options.tlsKey], ["tls-cert", options.tlsCert]] as const) {
    onlyFor(flag, value, false);
  }
  if (options.behindTlsProxy) throw new UsageError(`--behind-tls-proxy solo se usa con server start.`);
  if (options.readOnly) throw new UsageError(`--read-only solo se usa con server start.`);

  let scopes: ApiScope[] | undefined;
  let orgs: "*" | string[] | undefined;
  let name: string | undefined;
  let expiresAt: Date | undefined;
  if (creating || updating) {
    if (options.scopes !== undefined) scopes = parseScopes(options.scopes);
    if (options.orgs !== undefined) orgs = parseOrgs(options.orgs);
    name = options.name;
    if (creating && (name === undefined || scopes === undefined || orgs === undefined)) {
      throw new UsageError("clients create necesita --name, --scopes y --orgs (usa --orgs '*' para todas las organizaciones).");
    }
    if (updating && name === undefined && scopes === undefined && orgs === undefined) throw new UsageError("clients update necesita al menos uno de --name, --scopes, --orgs.");
  }
  if (group === "keys" && action === "create") {
    if (options.client === undefined) throw new UsageError("keys create necesita --client <id o nombre>.");
    if (options.expiresInDays !== undefined) {
      const days = Number(options.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 1825) throw new UsageError("--expires-in-days necesita un número entero entre 1 y 1825.");
      expiresAt = new Date(Date.now() + days * 86_400_000);
    }
  }

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport(command, "Configuración", error), json);
    return;
  }

  const mutating = !(group === "clients" && (action === "list" || action === "show"));
  let driver: DatabaseDriver;
  try {
    driver = await openDriver(config.database, cwd, mutating ? "write" : "inspect");
  } catch (error) {
    emit(failReport(command, "Base de datos", error), json);
    return;
  }

  let report: Report;
  try {
    const status = await driver.migrationStatus();
    if (status.pending.length > 0) {
      report = { command, checks: [{ name: "Migraciones", severity: "fail", message: `faltan migraciones (${status.pending.length}): corre "uniora migrate" primero` }], data: { target: driver.target } };
    } else {
      const service = createApiCredentialService({ storage: driver.apiCredentials() });
      report = await perform(service, command, group, action, { reference, name, scopes, orgs, client: options.client, expiresAt }, driver.target, json);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ApiCredentialError ? ` [${error.code}]` : "";
    report = { command, checks: [{ name: "Servidor", severity: "fail", message: `${message}${code}` }], data: { target: driver.target } };
  } finally {
    await driver.close();
  }
  emit(report, json);
}

interface Input {
  reference: string | undefined;
  name: string | undefined;
  scopes: ApiScope[] | undefined;
  orgs: "*" | string[] | undefined;
  client: string | undefined;
  expiresAt: Date | undefined;
}

async function perform(service: ApiCredentialService, command: string, group: string, action: string, input: Input, target: string | undefined, json: boolean): Promise<Report> {
  const actor = operator();
  const ok = (message: string, data: Record<string, unknown>, name = "Servidor"): Report => ({
    command,
    checks: [{ name, severity: "ok", message }],
    data: { target, ...data },
  });

  if (group === "clients") {
    switch (action) {
      case "create": {
        const client = await service.createClient({ actor, name: input.name!, scopes: input.scopes!, organizations: input.orgs! });
        return ok(`cliente "${client.name}" creado (${client.id}): ${client.scopes.join(", ")} · ${orgsText(client)}. Crea su clave con: uniora server keys create --client ${client.id}`, { client: describeClient(client) });
      }
      case "update": {
        const current = await resolveClient(service, input.reference!);
        const client = await service.updateClient({
          actor,
          clientId: current.id,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
          ...(input.orgs !== undefined ? { organizations: input.orgs } : {}),
          expectedVersion: current.version,
        });
        return ok(`cliente "${client.name}" actualizado: ${client.scopes.join(", ")} · ${orgsText(client)}. Surte efecto en la siguiente petición.`, { client: describeClient(client) });
      }
      case "list": {
        const clients = await service.listClients({ limit: 200 });
        const checks: CheckResult[] = clients.map((client) => ({
          name: client.name,
          severity: client.status === "active" ? "ok" : "warn",
          message: `${client.id} · ${client.status} · ${client.scopes.join(", ")} · ${orgsText(client)} · ${client.keys.filter((key) => !key.revokedAt).length} clave(s) activa(s)`,
        }));
        if (checks.length === 0) checks.push({ name: "Clientes", severity: "ok", message: 'ninguno todavía: crea uno con "uniora server clients create"' });
        return { command, checks, data: { target, clients: clients.map((client) => describeClient(client, client.keys)) } };
      }
      case "show": {
        const client = await resolveClient(service, input.reference!);
        const full = (await service.getClient(client.id))!;
        const checks: CheckResult[] = [
          { name: full.name, severity: full.status === "active" ? "ok" : "warn", message: `${full.id} · ${full.status} · ${full.scopes.join(", ")} · ${orgsText(full)}` },
          ...full.keys.map((key) => ({
            name: `clave ${key.id}`,
            severity: key.revokedAt ? ("warn" as const) : ("ok" as const),
            message: `${key.hint} · ${key.revokedAt ? "revocada" : "activa"}${key.lastUsedAt ? ` · último uso ${key.lastUsedAt.toISOString()}` : " · sin usar"}`,
          })),
        ];
        return { command, checks, data: { target, client: describeClient(full, full.keys) } };
      }
      case "disable":
      case "enable": {
        const current = await resolveClient(service, input.reference!);
        const client =
          action === "disable"
            ? await service.disableClient({ actor, clientId: current.id, expectedVersion: current.version })
            : await service.enableClient({ actor, clientId: current.id, expectedVersion: current.version });
        return ok(action === "disable" ? `cliente "${client.name}" desactivado: todas sus claves dejan de funcionar en la siguiente petición` : `cliente "${client.name}" activado`, { client: describeClient(client) });
      }
    }
  }

  if (action === "create") {
    const client = await resolveClient(service, input.client!);
    const created = await service.createKey({ actor, clientId: client.id, ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}) });
    if (!json) {
      // La clave sale en su propia línea, sola, para poder copiarla o capturarla (`$(uniora server keys create ...)` no sirve: el resto va a stdout también).
      console.log(`✓ Clave: creada para "${client.name}" (${created.key.id}). Cópiala ahora: no se volverá a mostrar.`);
      console.log(created.token);
      return { command, checks: [], data: {} };
    }
    return { command, checks: [{ name: "Clave", severity: "ok", message: `creada para "${client.name}"` }], data: { target, keyId: created.key.id, clientId: client.id, token: created.token } };
  }
  const key = await service.revokeKey({ actor, keyId: input.reference! });
  return ok(`clave ${key.id} revocada: deja de funcionar en la siguiente petición`, { keyId: key.id }, "Clave");
}

function positiveInt(flag: string, text: string | undefined, min: number, max: number): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new UsageError(`--${flag} necesita un número entero entre ${min} y ${max}.`);
  return value;
}

/**
 * `uniora server start`: levanta la API. Falla cerrado: sin migraciones al día, sin TLS (o sin declarar un proxy TLS de
 * confianza) en una interfaz que no sea loopback, o con cualquier opción inválida, no arranca.
 */
export async function runServerStart(cwd: string, options: ServerOptions): Promise<void> {
  const json = options.json === true;
  const command = "server start";
  const port = positiveInt("port", options.port, 0, 65535);
  const hops = positiveInt("trusted-proxy-hops", options.trustedProxyHops, 0, 10);
  if ((options.tlsKey === undefined) !== (options.tlsCert === undefined)) throw new UsageError("--tls-key y --tls-cert van juntos.");
  for (const flag of ["name", "scopes", "orgs", "client", "expiresInDays"] as const) {
    if (options[flag] !== undefined) throw new UsageError(`--${flag === "expiresInDays" ? "expires-in-days" : flag} no se usa con ${command}.`);
  }

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport(command, "Configuración", error), json);
    return;
  }
  let driver: DatabaseDriver;
  try {
    driver = await openDriver(config.database, cwd, "write");
  } catch (error) {
    emit(failReport(command, "Base de datos", error), json);
    return;
  }

  let running: RunningServer | undefined;
  try {
    const status = await driver.migrationStatus();
    if (status.pending.length > 0 || status.modified.length > 0) {
      emit({ command, checks: [{ name: "Migraciones", severity: "fail", message: `la base no está al día (${status.pending.length} pendiente(s), ${status.modified.length} modificada(s)): corre "uniora migrate"` }] }, json);
      await driver.close();
      return;
    }
    const server = createUnioraServer({
      storage: driver.storage(),
      credentials: driver.apiCredentials(),
      ...(options.defaultProvider !== undefined ? { defaultProvider: options.defaultProvider } : {}),
      ...(hops !== undefined ? { trustedProxyHops: hops } : {}),
      readOnly: options.readOnly === true,
    });
    running = await server.listen({
      host: options.host ?? "127.0.0.1",
      port: port ?? 8787,
      ...(options.tlsKey !== undefined && options.tlsCert !== undefined
        ? { tls: { key: readFileSync(resolve(cwd, options.tlsKey)), cert: readFileSync(resolve(cwd, options.tlsCert)) } }
        : {}),
      ...(options.behindTlsProxy ? { behindTlsProxy: true } : {}),
    });
  } catch (error) {
    await driver.close();
    emit(failReport(command, "Servidor", error), json);
    return;
  }

  const started: Report = { command, checks: [{ name: "Servidor", severity: "ok", message: `escuchando en ${running.url}${options.readOnly ? " (solo lectura)" : ""}` }], data: { url: running.url, target: driver.target } };
  emit(started, json);
  options.onStarted?.(running);

  await new Promise<void>((done) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      options.stop?.removeEventListener("abort", stop);
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (options.stop?.aborted) stop();
    else options.stop?.addEventListener("abort", stop);
  });
  await running.close();
  await driver.close();
}
