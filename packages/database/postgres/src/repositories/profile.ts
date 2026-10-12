import type { Identity, IdentityProfileRepository, StoredIdentityProfile } from "@uniora/core";
import { MAX_PROFILE_BATCH, normalizeProfileInput } from "@uniora/core";
import type { Queryable } from "../queryable.js";

interface ProfileRow {
  provider: string;
  subject: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  updated_at: Date;
}

const COLUMNS = "provider, subject, display_name, email, avatar_url, updated_at";

function toProfile(row: ProfileRow): StoredIdentityProfile {
  return {
    identity: { provider: row.provider, subject: row.subject },
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    ...(row.email !== null ? { email: row.email } : {}),
    ...(row.avatar_url !== null ? { avatarUrl: row.avatar_url } : {}),
    updatedAt: row.updated_at,
  };
}

export function createProfileRepository(db: Queryable): IdentityProfileRepository {
  async function find(identity: Identity): Promise<StoredIdentityProfile | null> {
    const result = await db.query<ProfileRow>(`select ${COLUMNS} from uniora.identity_profiles where provider = $1 and subject = $2`, [identity.provider, identity.subject]);
    return result.rows[0] ? toProfile(result.rows[0]) : null;
  }

  return {
    async upsert(identity: Identity, input) {
      const change = normalizeProfileInput(input);
      if (Object.keys(change).length === 0) return find(identity);
      // One statement, so two syncs of the same person cannot interleave: a field that is absent keeps what is stored, `null` clears it.
      const set = (field: "displayName" | "email" | "avatarUrl"): [boolean, string | null] => [field in change, change[field] ?? null];
      const [setName, name] = set("displayName");
      const [setEmail, email] = set("email");
      const [setAvatar, avatar] = set("avatarUrl");
      const result = await db.query<ProfileRow>(
        `insert into uniora.identity_profiles (provider, subject, display_name, email, avatar_url)
         values ($1, $2, $3, $4, $5)
         on conflict (provider, subject) do update set
           display_name = case when $6 then excluded.display_name else uniora.identity_profiles.display_name end,
           email = case when $7 then excluded.email else uniora.identity_profiles.email end,
           avatar_url = case when $8 then excluded.avatar_url else uniora.identity_profiles.avatar_url end,
           updated_at = now()
         returning ${COLUMNS}`,
        [identity.provider, identity.subject, name, email, avatar, setName, setEmail, setAvatar],
      );
      const row = result.rows[0];
      if (!row) return null;
      // Clearing the last field leaves an empty row: an empty profile is no profile, so it goes.
      if (row.display_name === null && row.email === null && row.avatar_url === null) {
        await db.query("delete from uniora.identity_profiles where provider = $1 and subject = $2 and display_name is null and email is null and avatar_url is null", [identity.provider, identity.subject]);
        return null;
      }
      return toProfile(row);
    },
    async findMany(identities) {
      const unique = [...new Map(identities.slice(0, MAX_PROFILE_BATCH).map((identity) => [JSON.stringify([identity.provider, identity.subject]), identity])).values()];
      if (unique.length === 0) return [];
      const result = await db.query<ProfileRow>(
        `select ${COLUMNS} from uniora.identity_profiles
         where (provider, subject) in (select * from unnest($1::text[], $2::text[]))`,
        [unique.map((identity) => identity.provider), unique.map((identity) => identity.subject)],
      );
      return result.rows.map(toProfile);
    },
    async delete(identity) {
      const result = await db.query("delete from uniora.identity_profiles where provider = $1 and subject = $2", [identity.provider, identity.subject]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}
