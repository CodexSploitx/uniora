import { randomUUID } from "node:crypto";
import type { AuditLogRepository, Identity, IdentityLink, IdentityLinkRepository, LinkIdentityInput } from "@uniora/core";
import { IdentityLinkError } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";
import { isUniqueViolation } from "../sqlite-errors.js";

interface IdentityLinkRow {
  from_provider: string;
  from_subject: string;
  to_provider: string;
  to_subject: string;
  linked_at: string;
}

function toLink(row: IdentityLinkRow): IdentityLink {
  return {
    from: { provider: row.from_provider, subject: row.from_subject },
    to: { provider: row.to_provider, subject: row.to_subject },
    linkedAt: new Date(row.linked_at),
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.provider === b.provider && a.subject === b.subject;
}

/**
 * All of `link()`'s real work (checks + insert + audit). Always run inside
 * `db.atomic`: the "no chains" checks are separate reads followed by a write,
 * which Postgres could only make safe with a SERIALIZABLE transaction and a
 * `40001` retry loop (docs/security-pentest-2026-09-24.md Hallazgo 9). Here
 * the whole sequence — including the audit entry — is one `begin immediate`
 * transaction, so a concurrent link() or create() simply waits its turn and
 * then re-observes the committed state; and if anything fails, the link and
 * its audit entry roll back TOGETHER (Ronda 8: never a phantom audit entry
 * for a link that wasn't persisted).
 */
async function performLink(db: SqliteExecutor, auditLogs: AuditLogRepository, input: LinkIdentityInput): Promise<IdentityLink> {
  if (sameIdentity(input.from, input.to)) {
    throw new IdentityLinkError("Cannot link an identity to itself.");
  }

  // Anti-hijack: the 'from' identity must not already own a membership
  // directly, in ANY organization.
  const ownMembership = await db.query(
    `select 1 from uniora_memberships where provider = ?1 and subject = ?2 limit 1`,
    [input.from.provider, input.from.subject],
  );
  if (ownMembership.rowCount > 0) {
    throw new IdentityLinkError(
      "Cannot link: the 'from' identity already owns a membership directly. Linking it would create an ambiguous/hijackable lookup.",
    );
  }

  const existing = await db.query<IdentityLinkRow>(
    `select from_provider, from_subject, to_provider, to_subject, linked_at
     from uniora_identity_links where from_provider = ?1 and from_subject = ?2`,
    [input.from.provider, input.from.subject],
  );
  const existingRow = existing.rows[0];
  if (existingRow) {
    const existingLink = toLink(existingRow);
    if (sameIdentity(existingLink.to, input.to)) return existingLink; // idempotent
    throw new IdentityLinkError("Cannot link: the 'from' identity is already linked to a different target.");
  }

  // No chains in V1: 'to' must not itself be a 'from' of another link.
  const toIsAlias = await db.query(
    `select 1 from uniora_identity_links where from_provider = ?1 and from_subject = ?2`,
    [input.to.provider, input.to.subject],
  );
  if (toIsAlias.rowCount > 0) {
    throw new IdentityLinkError("Cannot link: the 'to' identity is itself an alias of another identity (no chains).");
  }

  // Symmetric to the check above (Hallazgo 6): if `from` is ALREADY the `to`
  // of some other link, accepting it would silently build a 2-hop chain.
  const fromIsAliasTarget = await db.query(
    `select 1 from uniora_identity_links where to_provider = ?1 and to_subject = ?2`,
    [input.from.provider, input.from.subject],
  );
  if (fromIsAliasTarget.rowCount > 0) {
    throw new IdentityLinkError(
      "Cannot link: the 'from' identity is itself the target of another identity's link (no chains).",
    );
  }

  const result = await db.query<IdentityLinkRow>(
    `insert into uniora_identity_links (from_provider, from_subject, to_provider, to_subject)
     values (?1, ?2, ?3, ?4)
     returning from_provider, from_subject, to_provider, to_subject, linked_at`,
    [input.from.provider, input.from.subject, input.to.provider, input.to.subject],
  );
  const row = result.rows[0];
  if (!row) throw new Error("uniora_identity_links insert did not return a row");

  // The one Core primitive that self-audits (Hallazgo 5): merging two
  // identities' access is dangerous enough to need a forensic trail whether or
  // not the host remembers one. Global entry (no organizationId) with a
  // deterministic id — `from`'s natural key — so Core needs no id generator.
  await auditLogs.record({
    id: `identity-link:${randomUUID()}`,
    actor: input.actor,
    action: "identity_link.created",
    target: { type: "identity_link", id: `${input.from.provider}:${input.from.subject}` },
    metadata: { from: input.from, to: input.to },
  });

  return toLink(row);
}

export function createIdentityLinkRepository(db: SqliteExecutor, auditLogs: AuditLogRepository): IdentityLinkRepository {
  return {
    async link(input: LinkIdentityInput) {
      try {
        return await db.atomic(() => performLink(db, auditLogs, input));
      } catch (error) {
        if (isUniqueViolation(error)) {
          // Another writer (a different process: this one is serialized) won
          // the race past the checks — reject cleanly, never leak the raw error.
          throw new IdentityLinkError("Cannot link: the 'from' identity was linked concurrently by another request.");
        }
        throw error;
      }
    },

    async resolve(identity: Identity) {
      const result = await db.query<IdentityLinkRow>(
        `select from_provider, from_subject, to_provider, to_subject, linked_at
         from uniora_identity_links where from_provider = ?1 and from_subject = ?2`,
        [identity.provider, identity.subject],
      );
      const row = result.rows[0];
      return row ? toLink(row).to : identity;
    },
  };
}
