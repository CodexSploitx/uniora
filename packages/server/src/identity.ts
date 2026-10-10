import type { Identity } from "@uniora/core";
import { isReservedIdentityProvider } from "@uniora/core";
import { ApiError } from "./errors.js";

/**
 * The full identity of a request that sent `{ provider?, subject }`.
 *
 * The provider is an OPAQUE LABEL chosen by whoever runs the server, not the name of the auth vendor, so most callers never
 * send it: the configured default is used. It is part of every stored identity (it keeps two auth systems' ids from
 * colliding and makes migrating provider possible), so it is completed here, before anything else, and never guessed: with
 * no default configured and none sent, the request is refused.
 *
 * The labels UNIORA uses for its own principals in the audit log can never be an end user.
 */
export function completeIdentity(
  input: { provider?: string | undefined; subject: string },
  defaultProvider: string | undefined,
  path: string,
): Identity {
  const provider = input.provider ?? defaultProvider;
  if (provider === undefined) {
    throw new ApiError(400, "identity_provider_required", { issues: [{ path: `${path}.provider`, code: "required" }] });
  }
  if (isReservedIdentityProvider(provider)) {
    throw new ApiError(400, "identity_provider_reserved", { issues: [{ path: `${path}.provider`, code: "pattern" }] });
  }
  return { provider, subject: input.subject };
}

const ACTOR_SUBJECT = "Uniora-Actor-Subject";
const ACTOR_PROVIDER = "Uniora-Actor-Provider";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PROVIDER_LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

/**
 * The end user a delegated call speaks for, from the `Uniora-Actor-*` headers. Each header may appear once (a repeated one is
 * refused, not "last wins"), the subject is required, and the provider is completed from the server default exactly as in a body.
 * An actor whose provider is one of UNIORA's own labels is refused, so nobody can impersonate an internal principal in the audit log.
 */
export function actorFromHeaders(headers: { readonly subject: readonly string[]; readonly provider: readonly string[] }, defaultProvider: string | undefined): Identity {
  if (headers.subject.length === 0) throw new ApiError(400, "actor_required", { issues: [{ path: ACTOR_SUBJECT, code: "required" }] });
  if (headers.subject.length > 1 || headers.provider.length > 1) {
    throw new ApiError(400, "invalid_request", { issues: [{ path: headers.subject.length > 1 ? ACTOR_SUBJECT : ACTOR_PROVIDER, code: "too_many" }] });
  }
  // A header carries text, so the subject travels percent-encoded (`encodeURIComponent`): that keeps any id intact and the same as in a JSON body.
  let subject: string;
  try {
    subject = decodeURIComponent(headers.subject[0]!);
  } catch {
    throw new ApiError(400, "invalid_request", { issues: [{ path: ACTOR_SUBJECT, code: "pattern" }] });
  }
  const provider = headers.provider[0];
  if (subject.length < 1 || subject.length > 500 || CONTROL.test(subject)) throw new ApiError(400, "invalid_request", { issues: [{ path: ACTOR_SUBJECT, code: "pattern" }] });
  if (provider !== undefined && !PROVIDER_LABEL.test(provider)) throw new ApiError(400, "invalid_request", { issues: [{ path: ACTOR_PROVIDER, code: "pattern" }] });
  const resolved = provider ?? defaultProvider;
  if (resolved === undefined) throw new ApiError(400, "identity_provider_required", { issues: [{ path: ACTOR_PROVIDER, code: "required" }] });
  if (isReservedIdentityProvider(resolved)) throw new ApiError(400, "identity_provider_reserved", { issues: [{ path: ACTOR_PROVIDER, code: "pattern" }] });
  return { provider: resolved, subject };
}
