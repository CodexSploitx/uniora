import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AuditLogRepository, Identity, IdentityLink, IdentityLinkRepository, LinkIdentityInput } from "@uniora/core";
import { IdentityLinkError } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isUniqueViolation } from "../pg-errors.js";
import { createAuditLogRepository } from "./audit-log.js";

interface IdentityLinkRow {
  from_provider: string;
  from_subject: string;
  to_provider: string;
  to_subject: string;
  linked_at: Date;
}

function toLink(row: IdentityLinkRow): IdentityLink {
  return {
    from: { provider: row.from_provider, subject: row.from_subject },
    to: { provider: row.to_provider, subject: row.to_subject },
    linkedAt: row.linked_at,
  };
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.provider === b.provider && a.subject === b.subject;
}

/** Postgres error code for a serializable-transaction conflict (SSI). */
const SERIALIZATION_FAILURE = "40001";

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === SERIALIZATION_FAILURE;
}

/**
 * All of `link()`'s real work (checks + insert + audit), against whatever
 * `Queryable` it's given. Shared by both call paths below: the ordinary one
 * (checks run under whatever isolation the caller's connection already has —
 * READ COMMITTED by default, or the caller's own transaction if this is
 * invoked through `storage.transaction()`) and the SERIALIZABLE-wrapped one.
 */
async function performLink(db: Queryable, auditLogs: AuditLogRepository, input: LinkIdentityInput): Promise<IdentityLink> {
  if (sameIdentity(input.from, input.to)) {
    throw new IdentityLinkError("Cannot link an identity to itself.");
  }

  // Anti-hijack: the 'from' identity must not already own a membership
  // directly, in ANY organization — linking it away would make its own
  // membership unreachable and could be used to smuggle access into a
  // membership that isn't rightfully the actor's.
  const ownMembership = await db.query(
    `select 1 from uniora.memberships where provider = $1 and subject = $2 limit 1`,
    [input.from.provider, input.from.subject],
  );
  if ((ownMembership.rowCount ?? 0) > 0) {
    throw new IdentityLinkError(
      "Cannot link: the 'from' identity already owns a membership directly. Linking it would create an ambiguous/hijackable lookup.",
    );
  }

  const existing = await db.query<IdentityLinkRow>(
    `select from_provider, from_subject, to_provider, to_subject, linked_at
     from uniora.identity_links where from_provider = $1 and from_subject = $2`,
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
    `select 1 from uniora.identity_links where from_provider = $1 and from_subject = $2`,
    [input.to.provider, input.to.subject],
  );
  if ((toIsAlias.rowCount ?? 0) > 0) {
    throw new IdentityLinkError("Cannot link: the 'to' identity is itself an alias of another identity (no chains).");
  }

  // Symmetric to the check above (docs/security-pentest-2026-09-24.md
  // Hallazgo 6 — "no chains" was only enforced in one direction): if
  // `from` is ALREADY the `to` of some other link, accepting it here
  // would silently build a 2-hop chain (`other -> from -> to`) through
  // sheer construction order, even though attempting that same chain the
  // other way (`to` already a `from`) is correctly rejected above.
  const fromIsAliasTarget = await db.query(
    `select 1 from uniora.identity_links where to_provider = $1 and to_subject = $2`,
    [input.from.provider, input.from.subject],
  );
  if ((fromIsAliasTarget.rowCount ?? 0) > 0) {
    throw new IdentityLinkError(
      "Cannot link: the 'from' identity is itself the target of another identity's link (no chains).",
    );
  }

  const result = await db.query<IdentityLinkRow>(
    `insert into uniora.identity_links (from_provider, from_subject, to_provider, to_subject)
     values ($1, $2, $3, $4)
     returning from_provider, from_subject, to_provider, to_subject, linked_at`,
    [input.from.provider, input.from.subject, input.to.provider, input.to.subject],
  );
  const row = result.rows[0];
  if (!row) throw new Error("uniora.identity_links insert did not return a row");

  // Security fix (docs/security-pentest-2026-09-24.md Hallazgo 5):
  // `input.actor` exists specifically "for the mandatory audit trail"
  // (see the interface JSDoc) — this is the one Core primitive that
  // self-audits, because merging two identities' access is dangerous
  // enough to require a forensic trail regardless of whether the host
  // caller remembers to add one of its own. Global entry (no
  // `organizationId`): a link isn't scoped to any single organization.
  // Random id (audit F-11): a caller-chosen or guessable id could be pre-inserted into the audit
  // table to make this self-audit collide and block the link with a misleading error.
  await auditLogs.record({
    id: `identity-link:${randomUUID()}`,
    actor: input.actor,
    action: "identity_link.created",
    target: { type: "identity_link", id: `${input.from.provider}:${input.from.subject}` },
    metadata: { from: input.from, to: input.to },
  });

  return toLink(row);
}

/**
 * `db` is used for the ordinary path (including when this repository was
 * built inside `storage.transaction()`, where `db` is already the caller's
 * transactional client). `pool` is only passed at the top level (see
 * `storage.ts`) and, when present, is used to run `link()` in its OWN
 * short-lived SERIALIZABLE transaction — see the SECURITY FIX comment on
 * `link()` below for why.
 */
export function createIdentityLinkRepository(db: Queryable, auditLogs: AuditLogRepository, pool?: Pool): IdentityLinkRepository {
  return {
    async link(input: LinkIdentityInput) {
      if (!pool) return performLink(db, auditLogs, input);

      // SECURITY FIX (docs/security-pentest-2026-09-24.md Hallazgo 9, Ronda
      // 4): the "no chains" checks above (`performLink`) are separate
      // read statements followed by a separate insert — with no locking
      // between them, two concurrent `link()` calls that share an identity
      // as both a `to` and a `from` (e.g. `link(A, B)` and `link(B, C)`,
      // fired at the same instant) can each pass their own checks before
      // the other commits, producing exactly the 2-hop chain the Hallazgo 6
      // fix was meant to prevent — reproduced 20/20 times against real
      // Postgres with no protection.
      //
      // `FOR UPDATE` (used for the equivalent last-Owner race, see
      // `membership.ts`) doesn't help here: the rows being raced over don't
      // exist yet, so there's nothing to lock — a row lock can't protect
      // against a row that hasn't been inserted. This needs Postgres's
      // SERIALIZABLE isolation (SSI), which predicate-locks the READS
      // themselves and aborts one of the two transactions with a `40001`
      // (serialization_failure) once it detects the read/write dependency
      // cycle between them — the textbook "write skew" anomaly. Verified
      // empirically: 0/20 chains created under this fix (vs. 20/20 without
      // it); a control pair of fully independent, non-overlapping `link()`
      // calls both still succeed (migration 0015's index on
      // `(to_provider, to_subject)` is required for that — without it, SSI
      // has to predicate-lock the whole table for the `to_*` check, causing
      // unrelated concurrent `link()` calls to spuriously conflict too).
      //
      // Retried a few times with jittered backoff: a serialization failure
      // here can be a genuine conflict (a real chain attempt — the retry
      // will correctly re-observe the state and reject with the normal
      // `IdentityLinkError`) or an incidental one from unrelated concurrent
      // activity: it costs nothing to give both a fair chance to resolve
      // cleanly before we ever surface it to the caller.
      // SECURITY FIX (docs/security-pentest-2026-09-24.md Ronda 8 —
      // audit-log integrity under serialization failure): `auditLogs`
      // (the parameter above) is bound, at construction time, to `db` —
      // which at the top level of `createPostgresStorage` is the raw
      // `Pool`, not this attempt's `client`. Passing that pool-bound
      // repository into `performLink(client, auditLogs, input)` meant the
      // audit INSERT ran on a SEPARATE, always-autocommitting connection,
      // completely outside this attempt's SERIALIZABLE transaction — so a
      // `client.query("commit")` that later failed with `40001` correctly
      // rolled back the `identity_links` insert, but NOT the audit entry
      // that had already committed independently via the pool. Reproduced
      // deterministically (5/5 trials, and 7/7 in a wider contention
      // storm): an attempt that ultimately gets REJECTED (either by a
      // serialization failure or, on its retry, by the ordinary no-chains
      // check once it re-observes the winning attempt's state) can still
      // leave a permanent `identity_link.created` audit entry for a link
      // that was never actually persisted — a false audit trail for
      // exactly the primitive whose self-audit exists BECAUSE it's "the
      // single most dangerous primitive in Core" (Hallazgo 5). Fixed by
      // building a FRESH `AuditLogRepository` scoped to THIS attempt's
      // `client` on every iteration, so the audit write participates in
      // the same transaction as the `identity_links` insert it records —
      // a rollback now correctly undoes both together, atomically.
      let lastError: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        const client = await pool.connect();
        try {
          await client.query("begin isolation level serializable");
          const scopedAuditLogs = createAuditLogRepository(client);
          const result = await performLink(client, scopedAuditLogs, input);
          await client.query("commit");
          return result;
        } catch (error) {
          await client.query("rollback").catch(() => {});
          if (isSerializationFailure(error)) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1) + Math.random() * 20));
            continue;
          }
          if (isUniqueViolation(error)) {
            // A concurrent link() for the same `from` raced past the checks
            // above and won — reject cleanly instead of leaking the raw
            // Postgres unique-violation error.
            throw new IdentityLinkError("Cannot link: the 'from' identity was linked concurrently by another request.");
          }
          throw error;
        } finally {
          client.release();
        }
      }
      throw new IdentityLinkError(
        `Cannot link: too much concurrent identity-linking activity to safely resolve this request (${(lastError as Error | undefined)?.message ?? "serialization failure"}). Please retry.`,
      );
    },

    async unlink(input: { from: Identity; actor: Identity }) {
      // The delete and its audit entry commit together or not at all. Inside a caller's
      // `storage.transaction()` (`pool` absent) they simply join it.
      const run = async (conn: Queryable, audit: AuditLogRepository): Promise<boolean> => {
        const removed = await conn.query<IdentityLinkRow>(
          `delete from uniora.identity_links where from_provider = $1 and from_subject = $2
           returning from_provider, from_subject, to_provider, to_subject, linked_at`,
          [input.from.provider, input.from.subject],
        );
        const row = removed.rows[0];
        if (!row) return false;
        const link = toLink(row);
        await audit.record({
          id: `identity-link:${randomUUID()}`,
          actor: input.actor,
          action: "identity_link.removed",
          target: { type: "identity_link", id: `${input.from.provider}:${input.from.subject}` },
          metadata: { from: link.from, to: link.to },
        });
        return true;
      };
      if (!pool) return run(db, auditLogs);

      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await run(client, createAuditLogRepository(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async resolve(identity: Identity) {
      const result = await db.query<IdentityLinkRow>(
        `select from_provider, from_subject, to_provider, to_subject, linked_at
         from uniora.identity_links where from_provider = $1 and from_subject = $2`,
        [identity.provider, identity.subject],
      );
      const row = result.rows[0];
      return row ? toLink(row).to : identity;
    },
  };
}
