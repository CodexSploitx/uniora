import type { Identity, IdentityProfileRepository, StoredIdentityProfile } from "@uniora/core";
import { MAX_PROFILE_BATCH, normalizeProfileInput } from "@uniora/core";
import type { SqliteExecutor } from "../executor.js";

interface ProfileRow {
  provider: string;
  subject: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  updated_at: string;
}

const COLUMNS = "provider, subject, display_name, email, avatar_url, updated_at";

function toProfile(row: ProfileRow): StoredIdentityProfile {
  return {
    identity: { provider: row.provider, subject: row.subject },
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    ...(row.email !== null ? { email: row.email } : {}),
    ...(row.avatar_url !== null ? { avatarUrl: row.avatar_url } : {}),
    updatedAt: new Date(row.updated_at),
  };
}

export function createProfileRepository(db: SqliteExecutor): IdentityProfileRepository {
  async function find(identity: Identity): Promise<StoredIdentityProfile | null> {
    const result = await db.query<ProfileRow>(`select ${COLUMNS} from uniora_identity_profiles where provider = ?1 and subject = ?2`, [identity.provider, identity.subject]);
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  }

  return {
    async upsert(identity: Identity, input) {
      const change = normalizeProfileInput(input);
      if (Object.keys(change).length === 0) return find(identity);
      const set = (field: "displayName" | "email" | "avatarUrl"): [number, string | null] => [field in change ? 1 : 0, change[field] ?? null];
      const [setName, name] = set("displayName");
      const [setEmail, email] = set("email");
      const [setAvatar, avatar] = set("avatarUrl");
      // One atomic unit: a field that is absent keeps what is stored, `null` clears it, and clearing the last one removes the row.
      return db.atomic(async () => {
        await db.query(
          `insert into uniora_identity_profiles (provider, subject, display_name, email, avatar_url)
           values (?1, ?2, ?3, ?4, ?5)
           on conflict (provider, subject) do update set
             display_name = case when ?6 = 1 then excluded.display_name else uniora_identity_profiles.display_name end,
             email = case when ?7 = 1 then excluded.email else uniora_identity_profiles.email end,
             avatar_url = case when ?8 = 1 then excluded.avatar_url else uniora_identity_profiles.avatar_url end,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
          [identity.provider, identity.subject, name, email, avatar, setName, setEmail, setAvatar],
        );
        await db.query(
          "delete from uniora_identity_profiles where provider = ?1 and subject = ?2 and display_name is null and email is null and avatar_url is null",
          [identity.provider, identity.subject],
        );
        return find(identity);
      });
    },
    async findMany(identities) {
      const unique = [...new Map(identities.slice(0, MAX_PROFILE_BATCH).map((identity) => [JSON.stringify([identity.provider, identity.subject]), identity])).values()];
      if (unique.length === 0) return [];
      const params: string[] = [];
      const clauses = unique.map((identity) => {
        params.push(identity.provider, identity.subject);
        return `(provider = ?${params.length - 1} and subject = ?${params.length})`;
      });
      const result = await db.query<ProfileRow>(`select ${COLUMNS} from uniora_identity_profiles where ${clauses.join(" or ")}`, params);
      return result.rows.map(toProfile);
    },
    async delete(identity) {
      const result = await db.query("delete from uniora_identity_profiles where provider = ?1 and subject = ?2", [identity.provider, identity.subject]);
      return result.rowCount > 0;
    },
  };
}
