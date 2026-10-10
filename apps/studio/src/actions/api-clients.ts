"use server";

import { API_SCOPE_LIST, createApiCredentialService } from "@uniora/core";
import type { ApiScope } from "@uniora/core";
import { getApiCredentialStorage } from "@/lib/db";
import { InputError, StudioError } from "@/lib/validate";
import { guarded, studioActor, text, type ActionResult } from "@/actions/mutate";

const PATHS = ["/api-clients"];
const service = () => createApiCredentialService({ storage: getApiCredentialStorage() });

function scopesOf(value: unknown): ApiScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > API_SCOPE_LIST.length) throw new InputError("mustBeList", "field.scopes");
  const scopes = value.map((item) => text(item, "field.scopes", { max: 64 }));
  const unknown = scopes.find((scope) => !(API_SCOPE_LIST as readonly string[]).includes(scope));
  if (unknown) throw new StudioError("errors.scopeUnknown");
  return [...new Set(scopes)] as ApiScope[];
}

/** `"*"` for every organization, or the listed ids. The browser sends an explicit flag, so an empty list can never mean "everything". */
function organizationsOf(all: unknown, ids: unknown): "*" | string[] {
  if (all === true) return "*";
  if (all !== false || !Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new InputError("mustBeList", "field.organizations");
  return [...new Set(ids.map((id) => text(id, "field.organization", { max: 200 })))];
}

/** A new API client: a backend of yours that will call the API. Its keys are created separately. */
export async function createApiClient(args: { name: string; scopes: string[]; allOrganizations: boolean; organizations?: string[] }): Promise<ActionResult<{ id: string }>> {
  return guarded(PATHS, async () => {
    const client = await service().createClient({
      actor: studioActor(),
      name: text(args?.name, "field.name", { max: 100 }),
      scopes: scopesOf(args?.scopes),
      organizations: organizationsOf(args?.allOrganizations, args?.organizations),
    });
    return { id: client.id };
  });
}

export async function updateApiClient(args: {
  clientId: string;
  expectedVersion: number;
  name?: string;
  scopes?: string[];
  allOrganizations?: boolean;
  organizations?: string[];
}): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    const expectedVersion = Number(args?.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new StudioError("errors.unexpected");
    await service().updateClient({
      actor: studioActor(),
      clientId: text(args?.clientId, "field.client", { max: 200 }),
      expectedVersion,
      ...(args.name !== undefined ? { name: text(args.name, "field.name", { max: 100 }) } : {}),
      ...(args.scopes !== undefined ? { scopes: scopesOf(args.scopes) } : {}),
      ...(args.allOrganizations !== undefined ? { organizations: organizationsOf(args.allOrganizations, args.organizations) } : {}),
    });
  });
}

/** Disabling stops every key of the client on its next request; enabling brings the still-valid ones back. */
export async function setApiClientEnabled(args: { clientId: string; enabled: boolean }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    const clientId = text(args?.clientId, "field.client", { max: 200 });
    if (args.enabled === true) await service().enableClient({ actor: studioActor(), clientId });
    else await service().disableClient({ actor: studioActor(), clientId });
  });
}

/**
 * Creates a key and returns it. THIS RESPONSE IS THE ONLY TIME THE KEY EXISTS IN READABLE FORM: it is not stored (only its
 * SHA-256 is), so the page that shows it must not keep it beyond the dialog.
 */
export async function createApiKey(args: { clientId: string; expiresInDays?: number }): Promise<ActionResult<{ token: string; keyId: string }>> {
  return guarded(PATHS, async () => {
    let expiresAt: Date | undefined;
    if (args?.expiresInDays !== undefined) {
      const days = Number(args.expiresInDays);
      if (!Number.isInteger(days) || days < 1 || days > 1825) throw new StudioError("errors.keyLifetime");
      expiresAt = new Date(Date.now() + days * 86_400_000);
    }
    const created = await service().createKey({ actor: studioActor(), clientId: text(args?.clientId, "field.client", { max: 200 }), ...(expiresAt ? { expiresAt } : {}) });
    return { token: created.token, keyId: created.key.id };
  });
}

export async function revokeApiKey(args: { keyId: string }): Promise<ActionResult> {
  return guarded(PATHS, async () => {
    await service().revokeKey({ actor: studioActor(), keyId: text(args?.keyId, "field.key", { max: 200 }) });
  });
}
