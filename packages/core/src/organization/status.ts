import { OrganizationError } from "./slug.js";
import { ORGANIZATION_STATUSES, type OrganizationStatus } from "./types.js";

export const MAX_STATUS_REASON_LENGTH = 500;

/** Throws `OrganizationError` (`organization_status_invalid`) unless `value` is one of `ORGANIZATION_STATUSES`. */
export function assertOrganizationStatus(value: unknown): OrganizationStatus {
  if (typeof value !== "string" || !(ORGANIZATION_STATUSES as readonly string[]).includes(value)) {
    throw new OrganizationError(
      `Organization status must be one of: ${ORGANIZATION_STATUSES.join(", ")}.`,
      "organization_status_invalid",
    );
  }
  return value as OrganizationStatus;
}

/** Trims the optional reason; empty means none. Oversized text is rejected, not cut. */
export function sanitizeStatusReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  if (typeof reason !== "string") throw new OrganizationError("The status reason must be text.", "organization_status_invalid");
  const trimmed = reason.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_STATUS_REASON_LENGTH) {
    throw new OrganizationError(
      `The status reason cannot exceed ${MAX_STATUS_REASON_LENGTH} characters.`,
      "organization_status_invalid",
    );
  }
  return trimmed;
}
