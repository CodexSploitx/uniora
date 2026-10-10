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
