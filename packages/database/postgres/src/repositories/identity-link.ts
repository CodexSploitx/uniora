import type { Identity, IdentityLink, IdentityLinkRepository, LinkIdentityInput } from "@uniora/core";
import { IdentityLinkError } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { isUniqueViolation } from "../pg-errors.js";

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

export function createIdentityLinkRepository(db: Queryable): IdentityLinkRepository {
  return {
    async link(input: LinkIdentityInput) {
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

      try {
        const result = await db.query<IdentityLinkRow>(
          `insert into uniora.identity_links (from_provider, from_subject, to_provider, to_subject)
           values ($1, $2, $3, $4)
           returning from_provider, from_subject, to_provider, to_subject, linked_at`,
          [input.from.provider, input.from.subject, input.to.provider, input.to.subject],
        );
        const row = result.rows[0];
        if (!row) throw new Error("uniora.identity_links insert did not return a row");
        return toLink(row);
      } catch (error) {
        // A concurrent link() for the same `from` raced past the checks
        // above and won — reject cleanly instead of leaking the raw
        // Postgres unique-violation error.
        if (isUniqueViolation(error)) {
          throw new IdentityLinkError("Cannot link: the 'from' identity was linked concurrently by another request.");
        }
        throw error;
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
