import type { Identity } from "../identity/types.js";
import type { UnioraStorage } from "../storage/types.js";
import { randomId } from "../invitation/token.js";
import { ACCESS_RULE_REFUSALS, AccessError } from "./errors.js";

/**
 * Leaves an `access.change_refused` entry when one of the four rules stopped an actor who had passed the permission gate
 * (a refusal for lacking the permission is not recorded: strangers could flood the log). Written after the failed transaction,
 * best effort: the refusal stands either way. Returns nothing; never throws.
 */
export async function recordAccessRefusal(
  storage: Pick<UnioraStorage, "auditLogs">,
  error: unknown,
  facts: { organizationId: string; actor: Identity; operation: string; target: { type: string; id: string } },
): Promise<void> {
  if (!(error instanceof AccessError) || !ACCESS_RULE_REFUSALS.has(error.code)) return;
  try {
    await storage.auditLogs.record({
      id: `audit:${randomId()}`,
      organizationId: facts.organizationId,
      actor: facts.actor,
      action: "access.change_refused",
      target: facts.target,
      metadata: { operation: facts.operation, code: error.code },
    });
  } catch {
    /* the refusal stands either way */
  }
}
