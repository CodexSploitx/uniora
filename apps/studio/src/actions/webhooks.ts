"use server";

import { createWebhookService, normalizeWebhookEvents } from "@uniora/core";
import { getWebhookStorage } from "@/lib/db";
import { InputError, StudioError } from "@/lib/validate";
import { guarded, studioActor, text, type ActionResult } from "@/actions/mutate";

const PATHS = ["/webhooks"];
// The default policy: https, and a public host. A receiver on a private network is registered with `uniora webhooks create` and the
// `server.webhooks.urlPolicy` of uniora.config.mjs, not from a browser.
const service = () => createWebhookService({ storage: getWebhookStorage() });

function eventsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new InputError("mustBeList", "field.events");
  const events = value.map((item) => text(item, "field.events", { max: 120 }));
  try {
    return normalizeWebhookEvents(events);
  } catch {
    throw new StudioError("errors.webhookEvents");
  }
}

/** `"*"` for every organization, or the listed ids. The browser sends an explicit flag, so an empty list can never mean "everything". */
function organizationsOf(all: unknown, ids: unknown): "*" | string[] {
  if (all === true) return "*";
  if (all !== false || !Array.isArray(ids) || ids.length === 0 || ids.length > 100) throw new InputError("mustBeList", "field.organizations");
  return [...new Set(ids.map((id) => text(id, "field.organization", { max: 200 })))];
}

/**
 * Registers an endpoint and returns its signing secret. THIS RESPONSE IS THE ONLY TIME THE SECRET IS SHOWN: no read returns it, so the
 * dialog that shows it must not keep it beyond itself.
 */
export async function createWebhook(args: { url: string; events: string[]; allOrganizations: boolean; organizations?: string[]; description?: string }): Promise<ActionResult<{ id: string; secret: string }>> {
  return guarded(PATHS, async () => {
    const created = await service().createEndpoint({
      actor: studioActor(),
      url: text(args?.url, "field.url", { max: 2000 }),
      events: eventsOf(args?.events),
      organizations: organizationsOf(args?.allOrganizations, args?.organizations),
      ...(args?.description !== undefined && args.description !== "" ? { description: text(args.description, "field.description", { max: 200 }) } : {}),
    });
    return { id: created.endpoint.id, secret: created.secret };
  });
}

export async function updateWebhook(args: { endpointId: string; expectedVersion: number; url?: string; events?: string[]; allOrganizations?: boolean; organizations?: string[]; description?: string }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    const expectedVersion = Number(args?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new StudioError("errors.unexpected");
    await service().updateEndpoint({
      actor: studioActor(),
      endpointId: text(args?.endpointId, "field.webhook", { max: 200 }),
      expectedVersion,
      ...(args.url !== undefined ? { url: text(args.url, "field.url", { max: 2000 }) } : {}),
      ...(args.events !== undefined ? { events: eventsOf(args.events) } : {}),
      ...(args.allOrganizations !== undefined ? { organizations: organizationsOf(args.allOrganizations, args.organizations) } : {}),
      ...(args.description !== undefined ? { description: args.description === "" ? null : text(args.description, "field.description", { max: 200 }) } : {}),
    });
  });
}

/** A disabled endpoint receives no new events and its queued deliveries wait; enabling it sends them. */
export async function setWebhookEnabled(args: { endpointId: string; enabled: boolean }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    const endpointId = text(args?.endpointId, "field.webhook", { max: 200 });
    if (args.enabled === true) await service().enableEndpoint({ actor: studioActor(), endpointId });
    else await service().disableEndpoint({ actor: studioActor(), endpointId });
  });
}

/** A new secret; the old one keeps signing for `graceHours` so the receiver can switch with no downtime. Like creation, the only time the new one is shown. */
export async function rotateWebhookSecret(args: { endpointId: string; graceHours?: number }): Promise<ActionResult<{ secret: string }>> {
  return guarded(PATHS, async () => {
    const hours = args?.graceHours === undefined ? 24 : Number(args.graceHours);
    if (!Number.isInteger(hours) || hours < 0 || hours > 168) throw new StudioError("errors.webhookGrace");
    const rotated = await service().rotateSecret({ actor: studioActor(), endpointId: text(args?.endpointId, "field.webhook", { max: 200 }), graceSeconds: hours * 3600 });
    return { secret: rotated.secret };
  });
}

export async function deleteWebhook(args: { endpointId: string }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    await service().deleteEndpoint({ actor: studioActor(), endpointId: text(args?.endpointId, "field.webhook", { max: 200 }) });
  });
}

/** Puts a delivery that gave up back in the queue. */
export async function requeueWebhookDelivery(args: { deliveryId: string }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    await service().requeueDelivery({ actor: studioActor(), deliveryId: text(args?.deliveryId, "field.delivery", { max: 400 }) });
  });
}
