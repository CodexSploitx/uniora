import { userInfo } from "node:os";
import { WebhookError, createWebhookService } from "@uniora/core";
import type { WebhookDelivery, WebhookEndpoint, WebhookService } from "@uniora/core";
import { createJsonLogger, createWebhookDispatcher } from "@uniora/server";
import { UsageError, type OptionSpec, type ParsedFlags } from "../cli/args.js";
import { JSON_SPEC, type CommonOptions } from "../cli/common.js";
import { emit, failReport, type CheckResult, type Report } from "../cli/output.js";
import { loadConfig } from "../config/loader.js";
import { openDriver } from "../database/open.js";
import type { DatabaseDriver } from "../database/types.js";

export const WEBHOOKS_SPEC: OptionSpec = {
  ...JSON_SPEC,
  url: "string",
  events: "string",
  orgs: "string",
  description: "string",
  reason: "string",
  "grace-seconds": "string",
  endpoint: "string",
  status: "string",
  limit: "string",
  once: "boolean",
};

export interface WebhooksOptions extends CommonOptions {
  readonly url?: string;
  readonly events?: string;
  readonly orgs?: string;
  readonly description?: string;
  readonly reason?: string;
  readonly graceSeconds?: string;
  readonly endpoint?: string;
  readonly status?: string;
  readonly limit?: string;
  readonly once?: boolean;
  /** Cierra `run` igual que SIGINT/SIGTERM (pruebas y quien lo embeba). */
  readonly stop?: AbortSignal;
}

export function webhooksOptionsFromFlags(flags: ParsedFlags, common: CommonOptions): WebhooksOptions {
  return {
    ...common,
    url: flags.url as string | undefined,
    events: flags.events as string | undefined,
    orgs: flags.orgs as string | undefined,
    description: flags.description as string | undefined,
    reason: flags.reason as string | undefined,
    graceSeconds: flags["grace-seconds"] as string | undefined,
    endpoint: flags.endpoint as string | undefined,
    status: flags.status as string | undefined,
    limit: flags.limit as string | undefined,
    once: flags.once === true,
  };
}

const ACTIONS = ["create", "list", "show", "update", "enable", "disable", "rotate-secret", "delete", "deliveries", "requeue", "test", "run"] as const;
type Action = (typeof ACTIONS)[number];
const USAGE = `Uso: uniora webhooks <${ACTIONS.join("|")}>`;

function operator(): { provider: string; subject: string } {
  let name = "unknown";
  try {
    name = userInfo().username || name;
  } catch {
    // Sin usuario de sistema resoluble: queda como "uniora-cli:unknown".
  }
  return { provider: "uniora-cli", subject: name };
}

function list(text: string, flag: string): string[] {
  const items = text.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) throw new UsageError(`${flag} tiene un elemento vacío: usa valores separados por comas, sin espacios sobrantes.`);
  return items;
}

function parseOrgs(text: string): "*" | string[] {
  if (text === "*") return "*";
  const orgs = list(text, "--orgs");
  if (orgs.includes("*")) throw new UsageError('--orgs: "*" va solo (todas las organizaciones) o se listan ids concretos, no ambos.');
  return orgs;
}

function integer(flag: string, text: string | undefined, min: number, max: number): number | undefined {
  if (text === undefined) return undefined;
  const value = /^\d{1,8}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) throw new UsageError(`--${flag} necesita un número entero entre ${min} y ${max}.`);
  return value;
}

/** La URL puede llevar un secreto en la ruta: lo que se imprime es solo el host. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "(URL inválida)";
  }
};

function describeEndpoint(endpoint: WebhookEndpoint): Record<string, unknown> {
  return {
    id: endpoint.id,
    // The path and query may carry a secret: reports (kept in CI logs) show the origin only.
    url: maskedUrl(endpoint.url),
    ...(endpoint.description !== undefined ? { description: endpoint.description } : {}),
    events: endpoint.events,
    organizations: endpoint.organizations,
    status: endpoint.status,
    ...(endpoint.disabledReason !== undefined ? { disabledReason: endpoint.disabledReason } : {}),
    consecutiveFailures: endpoint.consecutiveFailures,
    ...(endpoint.lastSuccessAt ? { lastSuccessAt: endpoint.lastSuccessAt.toISOString() } : {}),
    ...(endpoint.lastFailureAt ? { lastFailureAt: endpoint.lastFailureAt.toISOString() } : {}),
    version: endpoint.version,
    createdAt: endpoint.createdAt.toISOString(),
  };
}

function describeDelivery(delivery: WebhookDelivery): Record<string, unknown> {
  return {
    id: delivery.id,
    endpointId: delivery.endpointId,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    ...(delivery.organizationId !== undefined ? { organizationId: delivery.organizationId } : {}),
    status: delivery.status,
    attempts: delivery.attempts,
    createdAt: delivery.createdAt.toISOString(),
    nextAttemptAt: delivery.availableAt.toISOString(),
    ...(delivery.deliveredAt ? { deliveredAt: delivery.deliveredAt.toISOString() } : {}),
    ...(delivery.lastError !== undefined ? { lastError: delivery.lastError } : {}),
    ...(delivery.lastHttpStatus !== undefined ? { lastHttpStatus: delivery.lastHttpStatus } : {}),
  };
}

/** `https://hooks.example.com/…`: enough to recognise the receiver, never the part that can be a secret. */
function maskedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname === "/" && parsed.search === "" ? "/" : "/…"}`;
  } catch {
    return "(URL inválida)";
  }
}

const orgsText = (endpoint: WebhookEndpoint): string => (endpoint.organizations === "*" ? "todas" : `${endpoint.organizations.length} organización(es)`);
const summary = (endpoint: WebhookEndpoint): string =>
  `${endpoint.id} · ${endpoint.status}${endpoint.disabledReason ? ` (${endpoint.disabledReason})` : ""} · ${hostOf(endpoint.url)} · ${endpoint.events.join(", ")} · ${orgsText(endpoint)}`;

/** Un endpoint por id (los ids son largos y aleatorios: no hay búsqueda por nombre). */
async function need(service: WebhookService, id: string): Promise<WebhookEndpoint> {
  const endpoint = await service.getEndpoint(id.trim());
  if (!endpoint) throw new WebhookError(`No hay ningún endpoint con id "${id}".`, "webhook_endpoint_not_found");
  return endpoint;
}

/**
 * `uniora webhooks ...`: a dónde y qué eventos manda UNIORA, y el worker que los envía. Habla directo con la base (la raíz de
 * confianza); ninguna ruta HTTP gestiona webhooks, porque un endpoint recibe los eventos de TODAS las organizaciones. El secreto de
 * firma se imprime UNA vez (al crear o rotar): después solo lo lee el worker.
 */
export async function runWebhooks(args: readonly string[], cwd: string = process.cwd(), options: WebhooksOptions = {}): Promise<void> {
  const json = options.json === true;
  const [action, reference] = args;
  if (action === undefined || !(ACTIONS as readonly string[]).includes(action)) throw new UsageError(`${USAGE}${action ? ` ("${action}" no existe)` : ""}.`);
  const command = `webhooks ${action}`;
  const act = action as Action;

  // Todo se valida antes de tocar la base.
  const needsReference = ["show", "update", "enable", "disable", "rotate-secret", "delete", "requeue", "test"].includes(act);
  if (needsReference && reference === undefined) throw new UsageError(`${command} necesita el id ${act === "requeue" ? "de la entrega" : "del endpoint"}.`);
  if (!needsReference && reference !== undefined) throw new UsageError(`${command} no acepta argumentos ("${reference}").`);
  const onlyFor = (flag: string, present: unknown, valid: boolean) => {
    if (present !== undefined && !valid) throw new UsageError(`--${flag} no se usa con ${command}.`);
  };
  const changes = act === "create" || act === "update";
  onlyFor("url", options.url, changes);
  onlyFor("events", options.events, changes);
  onlyFor("orgs", options.orgs, changes);
  onlyFor("description", options.description, changes);
  onlyFor("reason", options.reason, act === "disable");
  onlyFor("grace-seconds", options.graceSeconds, act === "rotate-secret");
  onlyFor("endpoint", options.endpoint, act === "deliveries");
  onlyFor("status", options.status, act === "deliveries" || act === "list");
  onlyFor("limit", options.limit, act === "deliveries" || act === "list");
  onlyFor("once", options.once ? true : undefined, act === "run");

  const events = options.events !== undefined ? list(options.events, "--events") : undefined;
  const orgs = options.orgs !== undefined ? parseOrgs(options.orgs) : undefined;
  if (act === "create" && (options.url === undefined || events === undefined)) throw new UsageError("webhooks create necesita --url y --events (p. ej. --events 'membership.*,role.*', o '*' para todo).");
  if (act === "update" && options.url === undefined && events === undefined && orgs === undefined && options.description === undefined) throw new UsageError("webhooks update necesita al menos uno de --url, --events, --orgs, --description.");
  const graceSeconds = integer("grace-seconds", options.graceSeconds, 0, 7 * 24 * 3600);
  const limit = integer("limit", options.limit, 1, 200);
  const deliveryStatus = options.status;
  if (act === "deliveries" && deliveryStatus !== undefined && !["pending", "delivered", "dead"].includes(deliveryStatus)) throw new UsageError("--status con deliveries es pending, delivered o dead.");
  if (act === "list" && deliveryStatus !== undefined && !["enabled", "disabled"].includes(deliveryStatus)) throw new UsageError("--status con list es enabled o disabled.");

  let config;
  try {
    config = await loadConfig(cwd, options);
  } catch (error) {
    emit(failReport(command, "Configuración", error), json);
    return;
  }
  const urlPolicy = config.server?.webhooks?.urlPolicy;
  if (urlPolicy?.allowInsecureHttp === true && urlPolicy.allowPrivateNetworks === true && process.env.NODE_ENV === "production") {
    // The same refusal as the server's: http to private networks together lets a registered endpoint reach internal services.
    emit(failReport(command, "Configuración", new Error("server.webhooks.urlPolicy permite http y redes privadas a la vez con NODE_ENV=production: un endpoint registrado podría llegar a tus servicios internos.")), json);
    return;
  }

  const mutating = !["list", "show", "deliveries", "test"].includes(act);
  let driver: DatabaseDriver;
  let pending = 0;
  try {
    const looking = await openDriver(config.database, cwd, "inspect");
    try {
      pending = (await looking.migrationStatus()).pending.length;
    } finally {
      await looking.close();
    }
    driver = await openDriver(config.database, cwd, pending === 0 && (mutating || act === "run") ? "write" : "inspect");
  } catch (error) {
    emit(failReport(command, "Base de datos", error), json);
    return;
  }

  if (act === "run" && pending === 0) {
    try {
      await runWorker(driver, config.server?.webhooks, options);
    } catch (error) {
      emit(failReport(command, "Webhooks", error), json);
    } finally {
      await driver.close();
    }
    return;
  }

  let report: Report;
  try {
    if (pending > 0) {
      report = { command, checks: [{ name: "Migraciones", severity: "fail", message: `faltan migraciones (${pending}): corre "uniora migrate" primero` }], data: { target: driver.target } };
    } else {
      const service = createWebhookService({ storage: driver.webhookStorage(), ...(urlPolicy ? { urlPolicy } : {}) });
      report = await perform(service, driver, command, act, { reference, url: options.url, events, orgs, description: options.description, reason: options.reason, graceSeconds, endpoint: options.endpoint, status: deliveryStatus, limit }, json, urlPolicy);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof WebhookError ? ` [${error.code}]` : "";
    report = { command, checks: [{ name: "Webhooks", severity: "fail", message: `${message}${code}` }], data: { target: driver.target } };
  } finally {
    await driver.close();
  }
  emit(report, json);
}

interface Input {
  reference: string | undefined;
  url: string | undefined;
  events: string[] | undefined;
  orgs: "*" | string[] | undefined;
  description: string | undefined;
  reason: string | undefined;
  graceSeconds: number | undefined;
  endpoint: string | undefined;
  status: string | undefined;
  limit: number | undefined;
}

async function perform(service: WebhookService, driver: DatabaseDriver, command: string, action: Action, input: Input, json: boolean, urlPolicy: { allowInsecureHttp?: boolean; allowPrivateNetworks?: boolean } | undefined): Promise<Report> {
  const actor = operator();
  const target = driver.target;
  const ok = (message: string, data: Record<string, unknown>, name = "Webhooks"): Report => ({ command, checks: [{ name, severity: "ok", message }], data: { target, ...data } });

  switch (action) {
    case "create": {
      const created = await service.createEndpoint({
        actor,
        url: input.url!,
        events: input.events!,
        organizations: input.orgs ?? "*",
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
      // El secreto sale en su propia línea, solo, para poder copiarlo (no se guarda en ningún informe ni log).
      const message = `endpoint creado: ${summary(created.endpoint)}. Guarda el secreto ahora: no se volverá a mostrar.`;
      if (!json) {
        console.log(`✓ Webhooks: ${message}`);
        console.log(created.secret);
        return { command, checks: [], data: {} };
      }
      return { command, checks: [{ name: "Webhooks", severity: "ok", message }], data: { target, endpoint: describeEndpoint(created.endpoint), secret: created.secret } };
    }
    case "update": {
      const current = await need(service, input.reference!);
      const endpoint = await service.updateEndpoint({
        actor,
        endpointId: current.id,
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
        ...(input.orgs !== undefined ? { organizations: input.orgs } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        expectedVersion: current.version,
      });
      return ok(`endpoint actualizado: ${summary(endpoint)}`, { endpoint: describeEndpoint(endpoint) });
    }
    case "list": {
      const endpoints = await service.listEndpoints({ limit: 200, ...(input.status ? { status: input.status as "enabled" | "disabled" } : {}) });
      const checks: CheckResult[] = endpoints.map((endpoint) => ({ name: endpoint.description ?? hostOf(endpoint.url), severity: endpoint.status === "enabled" ? "ok" : "warn", message: summary(endpoint) }));
      if (checks.length === 0) checks.push({ name: "Webhooks", severity: "ok", message: 'ninguno todavía: crea uno con "uniora webhooks create --url ... --events ..."' });
      return { command, checks, data: { target, endpoints: endpoints.map(describeEndpoint) } };
    }
    case "show": {
      const endpoint = await need(service, input.reference!);
      const [pendingCount, deadCount, recent] = await Promise.all([
        driver.webhookStorage().deliveries.count({ endpointId: endpoint.id, status: "pending" }),
        driver.webhookStorage().deliveries.count({ endpointId: endpoint.id, status: "dead" }),
        service.listDeliveries({ endpointId: endpoint.id, limit: 5 }),
      ]);
      const checks: CheckResult[] = [
        { name: endpoint.description ?? hostOf(endpoint.url), severity: endpoint.status === "enabled" ? "ok" : "warn", message: summary(endpoint) },
        { name: "Entregas", severity: deadCount > 0 ? "warn" : "ok", message: `${pendingCount} pendiente(s) · ${deadCount} sin entregar (dead) · ${endpoint.consecutiveFailures} fallo(s) seguido(s)` },
        ...recent.map((delivery) => ({ name: `entrega ${delivery.eventType}`, severity: delivery.status === "delivered" ? ("ok" as const) : delivery.status === "dead" ? ("fail" as const) : ("warn" as const), message: `${delivery.id} · ${delivery.status} · intento ${delivery.attempts}${delivery.lastError ? ` · ${delivery.lastError}` : ""}` })),
      ];
      return { command, checks, data: { target, endpoint: describeEndpoint(endpoint), deliveries: { pending: pendingCount, dead: deadCount, recent: recent.map(describeDelivery) } } };
    }
    case "disable":
    case "enable": {
      const current = await need(service, input.reference!);
      const endpoint =
        action === "disable"
          ? await service.disableEndpoint({ actor, endpointId: current.id, ...(input.reason !== undefined ? { reason: input.reason } : {}), expectedVersion: current.version })
          : await service.enableEndpoint({ actor, endpointId: current.id, expectedVersion: current.version });
      return ok(action === "disable" ? `endpoint desactivado: no recibe eventos nuevos y sus entregas esperan` : `endpoint activado: sus entregas en espera se envían`, { endpoint: describeEndpoint(endpoint) });
    }
    case "rotate-secret": {
      const current = await need(service, input.reference!);
      const rotated = await service.rotateSecret({ actor, endpointId: current.id, ...(input.graceSeconds !== undefined ? { graceSeconds: input.graceSeconds } : {}) });
      const grace = input.graceSeconds ?? 24 * 3600;
      const message = `secreto rotado: el anterior ${grace === 0 ? "deja de firmar ya" : `sigue firmando ${grace} segundos`}. Guarda el nuevo ahora: no se volverá a mostrar.`;
      if (!json) {
        console.log(`✓ Webhooks: ${message}`);
        console.log(rotated.secret);
        return { command, checks: [], data: {} };
      }
      return { command, checks: [{ name: "Webhooks", severity: "ok", message }], data: { target, endpoint: describeEndpoint(rotated.endpoint), secret: rotated.secret } };
    }
    case "delete": {
      const current = await need(service, input.reference!);
      await service.deleteEndpoint({ actor, endpointId: current.id });
      return ok(`endpoint ${current.id} borrado con sus entregas`, { endpointId: current.id });
    }
    case "deliveries": {
      const deliveries = await service.listDeliveries({
        ...(input.endpoint ? { endpointId: input.endpoint } : {}),
        ...(input.status ? { status: input.status as "pending" | "delivered" | "dead" } : {}),
        limit: input.limit ?? 50,
      });
      const checks: CheckResult[] = deliveries.map((delivery) => ({
        name: delivery.eventType,
        severity: delivery.status === "delivered" ? "ok" : delivery.status === "dead" ? "fail" : "warn",
        message: `${delivery.id} · ${delivery.status} · intento ${delivery.attempts}${delivery.lastHttpStatus !== undefined ? ` · HTTP ${delivery.lastHttpStatus}` : ""}${delivery.lastError ? ` · ${delivery.lastError}` : ""}`,
      }));
      if (checks.length === 0) checks.push({ name: "Entregas", severity: "ok", message: "ninguna con ese filtro" });
      return { command, checks, data: { target, deliveries: deliveries.map(describeDelivery) } };
    }
    case "requeue": {
      const delivery = await service.requeueDelivery({ actor, deliveryId: input.reference! });
      return ok(`entrega ${delivery.id} de nuevo en cola`, { delivery: describeDelivery(delivery) });
    }
    case "test": {
      const dispatcher = createWebhookDispatcher({ webhooks: driver.webhookStorage(), outbox: driver.storage().outbox, ...(urlPolicy ? { urlPolicy } : {}) });
      const result = await dispatcher.sendTest(input.reference!.trim());
      if (!result) throw new WebhookError(`No hay ningún endpoint con id "${input.reference}".`, "webhook_endpoint_not_found");
      return {
        command,
        checks: [{ name: "Prueba", severity: result.ok ? "ok" : "fail", message: result.ok ? `el receptor respondió HTTP ${result.status} en ${result.durationMs} ms` : `no llegó: ${result.error}` }],
        data: { target, ok: result.ok, ...(result.status !== undefined ? { httpStatus: result.status } : {}), durationMs: result.durationMs, ...(result.error ? { error: result.error } : {}) },
      };
    }
    case "run":
      throw new Error("unreachable");
  }
}

async function runWorker(driver: DatabaseDriver, section: { urlPolicy?: { allowInsecureHttp?: boolean; allowPrivateNetworks?: boolean }; concurrency?: number; timeoutMs?: number; maxAttempts?: number; disableAfterFailures?: number; disableAfterMinutes?: number; pollIntervalMs?: number; retainDeliveredDays?: number } | undefined, options: WebhooksOptions): Promise<void> {
  const json = options.json === true;
  const dispatcher = createWebhookDispatcher({
    webhooks: driver.webhookStorage(),
    outbox: driver.storage().outbox,
    logger: createJsonLogger({ write: (line) => process.stderr.write(`${line}\n`) }),
    ...(section?.urlPolicy ? { urlPolicy: section.urlPolicy } : {}),
    ...(section?.concurrency !== undefined ? { concurrency: section.concurrency } : {}),
    ...(section?.timeoutMs !== undefined ? { timeoutMs: section.timeoutMs } : {}),
    ...(section?.maxAttempts !== undefined ? { maxAttempts: section.maxAttempts } : {}),
    ...(section?.disableAfterFailures !== undefined ? { disableAfterFailures: section.disableAfterFailures } : {}),
    ...(section?.disableAfterMinutes !== undefined ? { disableAfterMinutes: section.disableAfterMinutes } : {}),
    ...(section?.pollIntervalMs !== undefined ? { pollIntervalMs: section.pollIntervalMs } : {}),
    ...(section?.retainDeliveredDays !== undefined ? { retainDeliveredDays: section.retainDeliveredDays } : {}),
  });
  if (options.once) {
    // Para un cron: una ronda (fan-out y envío de lo vencido) y salir.
    const result = await dispatcher.tick();
    emit({ command: "webhooks run", checks: [{ name: "Webhooks", severity: "ok", message: `${result.fannedOut} evento(s) encolados · ${result.delivered} entregado(s) · ${result.failed} fallido(s)` }], data: { ...result, target: driver.target } }, json);
    return;
  }
  dispatcher.start();
  emit({ command: "webhooks run", checks: [{ name: "Webhooks", severity: "ok", message: "worker en marcha (Ctrl+C para parar)" }], data: { target: driver.target } }, json);
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
  await dispatcher.stop();
}
