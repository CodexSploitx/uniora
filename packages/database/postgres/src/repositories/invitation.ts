import type {
  CreateInvitationInput,
  Identity,
  Invitation,
  InvitationRepository,
  InvitationStatus,
  RecordDeliveryInput,
  SearchInvitationsOptions,
} from "@uniora/core";
import { InvitationError } from "@uniora/core";
import type { Queryable } from "../queryable.js";
import { toLikePattern } from "../pg-like.js";
import { searchCandidates } from "../pg-search.js";
import { isForeignKeyViolation, violatedConstraint } from "../pg-errors.js";

function likeOrNull(query: string | undefined): string | null {
  const trimmed = query?.trim();
  return trimmed ? toLikePattern(trimmed) : null;
}

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  invited_by_provider: string;
  invited_by_subject: string;
  status: InvitationStatus;
  created_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by_provider: string | null;
  accepted_by_subject: string | null;
  revoked_at: Date | null;
  delivery_status: "pending" | "sent" | "failed";
  delivery_attempts: number;
  delivery_sends: number;
  delivery_last_attempt_at: Date | null;
  delivery_sent_at: Date | null;
  delivery_last_error: string | null;
  role_ids: string[];
  team_ids: string[];
}

const SELECT_COLUMNS = `
  i.id, i.organization_id, i.email, i.invited_by_provider, i.invited_by_subject, i.status,
  i.created_at, i.expires_at, i.accepted_at, i.accepted_by_provider, i.accepted_by_subject, i.revoked_at,
  i.delivery_status, i.delivery_attempts, i.delivery_sends, i.delivery_last_attempt_at,
  i.delivery_sent_at, i.delivery_last_error,
  coalesce((select array_agg(role_id order by role_id) from uniora.invitation_roles where invitation_id = i.id), '{}') as role_ids,
  coalesce((select array_agg(team_id order by team_id) from uniora.invitation_teams where invitation_id = i.id), '{}') as team_ids`;

function toInvitation(row: InvitationRow): Invitation {
  const acceptedBy: Identity | undefined =
    row.accepted_by_provider !== null && row.accepted_by_subject !== null
      ? { provider: row.accepted_by_provider, subject: row.accepted_by_subject }
      : undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    roleIds: row.role_ids,
    teamIds: row.team_ids,
    invitedBy: { provider: row.invited_by_provider, subject: row.invited_by_subject },
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at ?? undefined,
    acceptedBy,
    revokedAt: row.revoked_at ?? undefined,
    delivery: {
      status: row.delivery_status,
      attempts: row.delivery_attempts,
      sends: row.delivery_sends,
      lastAttemptAt: row.delivery_last_attempt_at ?? undefined,
      sentAt: row.delivery_sent_at ?? undefined,
      lastError: row.delivery_last_error ?? undefined,
    },
  };
}

export function createInvitationRepository(db: Queryable): InvitationRepository {
  async function byId(id: string): Promise<Invitation | null> {
    const result = await db.query<InvitationRow>(`select ${SELECT_COLUMNS} from uniora.invitations i where i.id = $1`, [id]);
    const row = result.rows[0];
    return row ? toInvitation(row) : null;
  }

  return {
    async create(input: CreateInvitationInput) {
      try {
        // One statement, so the invitation and its roles are atomic whether
        // `db` is the pool or a transaction's client.
        await db.query(
          `with inserted as (
             insert into uniora.invitations
               (id, organization_id, email, token_hash, invited_by_provider, invited_by_subject, created_at, expires_at,
                idempotency_key, idempotency_hash)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $10, $11)
             returning id
           )
           , roles as (
             insert into uniora.invitation_roles (invitation_id, role_id)
             select inserted.id, role_id from inserted, unnest($9::text[]) as role_id
           )
           insert into uniora.invitation_teams (invitation_id, organization_id, team_id)
           select inserted.id, $2, team_id from inserted, unnest($12::text[]) as team_id`,
          [
            input.id,
            input.organizationId,
            input.email,
            input.tokenHash,
            input.invitedBy.provider,
            input.invitedBy.subject,
            input.createdAt,
            input.expiresAt,
            [...new Set(input.roleIds)],
            input.idempotency?.key ?? null,
            input.idempotency?.hash ?? null,
            [...new Set(input.teamIds ?? [])],
          ],
        );
      } catch (error) {
        if (violatedConstraint(error) === "invitations_one_pending_per_email") {
          throw new InvitationError("This e-mail already has a pending invitation to this organization.", "duplicate_pending");
        }
        if (violatedConstraint(error) === "invitations_idempotency_key_key") {
          throw new InvitationError("This idempotency key was already used.", "idempotency_conflict");
        }
        if (isForeignKeyViolation(error)) {
          throw new InvitationError("The organization, a chosen role or a chosen team does not exist.", "bad_request");
        }
        throw error;
      }
      const created = await byId(input.id);
      if (!created) throw new Error("uniora.invitations insert did not persist");
      return created;
    },

    findById: byId,

    async findByIdempotencyKey(organizationId: string, key: string) {
      const result = await db.query<InvitationRow & { idempotency_hash: string }>(
        `select ${SELECT_COLUMNS}, i.idempotency_hash
         from uniora.invitations i where i.organization_id = $1 and i.idempotency_key = $2`,
        [organizationId, key],
      );
      const row = result.rows[0];
      return row ? { invitation: toInvitation(row), hash: row.idempotency_hash } : null;
    },

    async findByTokenHash(tokenHash: string) {
      const result = await db.query<InvitationRow>(
        `select ${SELECT_COLUMNS} from uniora.invitations i where i.token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? toInvitation(row) : null;
    },

    async search(organizationId: string, options?: SearchInvitationsOptions) {
      const candidates = await searchCandidates(db, "invitations", options?.query, organizationId);
      const result = await db.query<InvitationRow>(
        `select ${SELECT_COLUMNS}
         from uniora.invitations i
         where i.organization_id = $1
           and ($2::text is null or i.status = $2)
           and ($3::text is null or (i.created_at, i.id) < (select created_at, id from uniora.invitations where id = $3))
           and ($5::text is null or i.email ilike $5)
           and ($6::text[] is null or i.id = any($6))
         order by i.created_at desc, i.id desc
         limit $4`,
        [organizationId, options?.status ?? null, options?.after ?? null, options?.limit ?? null, likeOrNull(options?.query), candidates],
      );
      return result.rows.map(toInvitation);
    },

    async count(organizationId: string, options?: Pick<SearchInvitationsOptions, "status" | "query"> & { limit?: number }) {
      const candidates = await searchCandidates(db, "invitations", options?.query, organizationId);
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
         from (
           select 1
           from uniora.invitations i
           where i.organization_id = $1
             and ($2::text is null or i.status = $2)
             and ($3::text is null or i.email ilike $3)
             and ($5::text[] is null or i.id = any($5))
           limit $4::integer
         ) matching`,
        [organizationId, options?.status ?? null, likeOrNull(options?.query), options?.limit ?? null, candidates],
      );
      return Number(result.rows[0]!.count);
    },

    async expireStale(organizationId: string, email: string, now: Date) {
      const result = await db.query(
        `update uniora.invitations set status = 'expired'
         where organization_id = $1 and email = $2 and status = 'pending' and expires_at <= $3`,
        [organizationId, email, now],
      );
      return result.rowCount ?? 0;
    },

    async rotateToken(id: string, input: { tokenHash: string; expiresAt: Date }) {
      const result = await db.query(
        `update uniora.invitations
         set token_hash = $2, expires_at = $3, delivery_status = 'pending', delivery_last_error = null
         where id = $1 and status = 'pending'`,
        [id, input.tokenHash, input.expiresAt],
      );
      return (result.rowCount ?? 0) > 0 ? byId(id) : null;
    },

    async revoke(id: string, now: Date) {
      const result = await db.query(
        `update uniora.invitations set status = 'revoked', revoked_at = $2 where id = $1 and status = 'pending'`,
        [id, now],
      );
      return (result.rowCount ?? 0) > 0 ? byId(id) : null;
    },

    async markAccepted(input: { tokenHash: string; identity: Identity; now: Date }) {
      const result = await db.query<{ id: string }>(
        `update uniora.invitations
         set status = 'accepted', accepted_at = $2, accepted_by_provider = $3, accepted_by_subject = $4
         where token_hash = $1 and status = 'pending' and expires_at > $2
         returning id`,
        [input.tokenHash, input.now, input.identity.provider, input.identity.subject],
      );
      const row = result.rows[0];
      return row ? byId(row.id) : null;
    },

    async recordDelivery(id: string, input: RecordDeliveryInput) {
      await db.query(
        `update uniora.invitations
         set delivery_status = $2,
             delivery_attempts = delivery_attempts + $3,
             delivery_sends = delivery_sends + 1,
             delivery_last_attempt_at = $4,
             delivery_sent_at = case when $2 = 'sent' then $4::timestamptz else delivery_sent_at end,
             delivery_last_error = case when $2 = 'failed' then $5 else null end
         where id = $1`,
        [id, input.status, input.attempts, input.at, input.error ?? null],
      );
    },

    async countCreatedSince(filter: { organizationId?: string; email?: string; since: Date }) {
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count from uniora.invitations
         where created_at >= $1
           and ($2::text is null or organization_id = $2)
           and ($3::text is null or email = $3)`,
        [filter.since, filter.organizationId ?? null, filter.email ?? null],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}
