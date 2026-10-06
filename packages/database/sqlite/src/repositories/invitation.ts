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
import type { SqliteExecutor } from "../executor.js";
import { parseList } from "../json.js";
import { isForeignKeyViolation, isUniqueViolation, violatedExactly } from "../sqlite-errors.js";

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  invited_by_provider: string;
  invited_by_subject: string;
  status: InvitationStatus;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by_provider: string | null;
  accepted_by_subject: string | null;
  revoked_at: string | null;
  delivery_status: "pending" | "sent" | "failed";
  delivery_attempts: number;
  delivery_sends: number;
  delivery_last_attempt_at: string | null;
  delivery_sent_at: string | null;
  delivery_last_error: string | null;
  role_ids: string;
}

const SELECT_COLUMNS = `
  i.id, i.organization_id, i.email, i.invited_by_provider, i.invited_by_subject, i.status,
  i.created_at, i.expires_at, i.accepted_at, i.accepted_by_provider, i.accepted_by_subject, i.revoked_at,
  i.delivery_status, i.delivery_attempts, i.delivery_sends, i.delivery_last_attempt_at,
  i.delivery_sent_at, i.delivery_last_error,
  (select json_group_array(role_id) from (
     select role_id from uniora_invitation_roles where invitation_id = i.id order by role_id
   )) as role_ids`;

function toInvitation(row: InvitationRow): Invitation {
  const acceptedBy: Identity | undefined =
    row.accepted_by_provider !== null && row.accepted_by_subject !== null
      ? { provider: row.accepted_by_provider, subject: row.accepted_by_subject }
      : undefined;
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    roleIds: parseList(row.role_ids),
    invitedBy: { provider: row.invited_by_provider, subject: row.invited_by_subject },
    status: row.status,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    acceptedAt: row.accepted_at !== null ? new Date(row.accepted_at) : undefined,
    acceptedBy,
    revokedAt: row.revoked_at !== null ? new Date(row.revoked_at) : undefined,
    delivery: {
      status: row.delivery_status,
      attempts: row.delivery_attempts,
      sends: row.delivery_sends,
      lastAttemptAt: row.delivery_last_attempt_at !== null ? new Date(row.delivery_last_attempt_at) : undefined,
      sentAt: row.delivery_sent_at !== null ? new Date(row.delivery_sent_at) : undefined,
      lastError: row.delivery_last_error ?? undefined,
    },
  };
}

export function createInvitationRepository(db: SqliteExecutor): InvitationRepository {
  async function byId(id: string): Promise<Invitation | null> {
    const result = await db.query<InvitationRow>(`select ${SELECT_COLUMNS} from uniora_invitations i where i.id = ?1`, [id]);
    const row = result.rows[0];
    return row ? toInvitation(row) : null;
  }

  return {
    async create(input: CreateInvitationInput) {
      try {
        await db.atomic(async () => {
          await db.query(
            `insert into uniora_invitations
               (id, organization_id, email, token_hash, invited_by_provider, invited_by_subject, created_at, expires_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
            [
              input.id,
              input.organizationId,
              input.email,
              input.tokenHash,
              input.invitedBy.provider,
              input.invitedBy.subject,
              input.createdAt,
              input.expiresAt,
            ],
          );
          for (const roleId of new Set(input.roleIds)) {
            await db.query(`insert into uniora_invitation_roles (invitation_id, role_id) values (?1, ?2)`, [input.id, roleId]);
          }
        });
      } catch (error) {
        if (violatedExactly(error, ["uniora_invitations.organization_id", "uniora_invitations.email"])) {
          throw new InvitationError("This e-mail already has a pending invitation to this organization.", "duplicate_pending");
        }
        if (isForeignKeyViolation(error)) {
          throw new InvitationError("The organization or a chosen role does not exist.", "bad_request");
        }
        if (isUniqueViolation(error)) throw new InvitationError("Could not create the invitation.", "bad_request");
        throw error;
      }
      const created = await byId(input.id);
      if (!created) throw new Error("uniora_invitations insert did not persist");
      return created;
    },

    findById: byId,

    async findByTokenHash(tokenHash: string) {
      const result = await db.query<InvitationRow>(
        `select ${SELECT_COLUMNS} from uniora_invitations i where i.token_hash = ?1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? toInvitation(row) : null;
    },

    async search(organizationId: string, options?: SearchInvitationsOptions) {
      const result = await db.query<InvitationRow>(
        `select ${SELECT_COLUMNS}
         from uniora_invitations i
         where i.organization_id = ?1
           and (?2 is null or i.status = ?2)
           and (?3 is null or (i.created_at, i.id) < (select created_at, id from uniora_invitations where id = ?3))
         order by i.created_at desc, i.id desc
         limit coalesce(?4, -1)`,
        [organizationId, options?.status ?? null, options?.after ?? null, options?.limit ?? null],
      );
      return result.rows.map(toInvitation);
    },

    async expireStale(organizationId: string, email: string, now: Date) {
      const result = await db.query(
        `update uniora_invitations set status = 'expired'
         where organization_id = ?1 and email = ?2 and status = 'pending' and expires_at <= ?3`,
        [organizationId, email, now],
      );
      return result.rowCount;
    },

    async rotateToken(id: string, input: { tokenHash: string; expiresAt: Date }) {
      const result = await db.query(
        `update uniora_invitations
         set token_hash = ?2, expires_at = ?3, delivery_status = 'pending', delivery_last_error = null
         where id = ?1 and status = 'pending'`,
        [id, input.tokenHash, input.expiresAt],
      );
      return result.rowCount > 0 ? byId(id) : null;
    },

    async revoke(id: string, now: Date) {
      const result = await db.query(
        `update uniora_invitations set status = 'revoked', revoked_at = ?2 where id = ?1 and status = 'pending'`,
        [id, now],
      );
      return result.rowCount > 0 ? byId(id) : null;
    },

    async markAccepted(input: { tokenHash: string; identity: Identity; now: Date }) {
      const result = await db.query<{ id: string }>(
        `update uniora_invitations
         set status = 'accepted', accepted_at = ?2, accepted_by_provider = ?3, accepted_by_subject = ?4
         where token_hash = ?1 and status = 'pending' and expires_at > ?2
         returning id`,
        [input.tokenHash, input.now, input.identity.provider, input.identity.subject],
      );
      const row = result.rows[0];
      return row ? byId(row.id) : null;
    },

    async recordDelivery(id: string, input: RecordDeliveryInput) {
      await db.query(
        `update uniora_invitations
         set delivery_status = ?2,
             delivery_attempts = delivery_attempts + ?3,
             delivery_sends = delivery_sends + 1,
             delivery_last_attempt_at = ?4,
             delivery_sent_at = case when ?2 = 'sent' then ?4 else delivery_sent_at end,
             delivery_last_error = case when ?2 = 'failed' then ?5 else null end
         where id = ?1`,
        [id, input.status, input.attempts, input.at, input.error ?? null],
      );
    },

    async countCreatedSince(filter: { organizationId?: string; email?: string; since: Date }) {
      const result = await db.query<{ count: number }>(
        `select count(*) as count from uniora_invitations
         where created_at >= ?1
           and (?2 is null or organization_id = ?2)
           and (?3 is null or email = ?3)`,
        [filter.since, filter.organizationId ?? null, filter.email ?? null],
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };
}
