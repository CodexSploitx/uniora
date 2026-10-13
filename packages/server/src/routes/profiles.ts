import { defineRoute } from "../route.js";
import { s } from "../schema.js";
import { IdentityInput } from "./common.js";

/** Up to this many people in one call: enough to backfill an application in pages, small enough to stay one bounded transaction. */
const MAX_PROFILES_PER_CALL = 100;

const text = (description: string, example: string) => s.optional(s.nullable(s.string({ min: 1, max: 320, description, example })));

/** The fields of a profile, shared by every call that can carry one. A field left out is kept as stored; `null` clears it. */
export const ProfileFields = {
  displayName: text("The person's name. Leave it out to keep what is stored; send `null` to clear it.", "Ana Pérez"),
  email: text("The e-mail the auth provider reported (display data only). Leave it out to keep what is stored; send `null` to clear it.", "ana@example.com"),
  avatarUrl: s.optional(
    s.nullable(
      s.string({
        min: 1,
        max: 2048,
        pattern: /^https?:\/\//i,
        description: "An `http(s)` URL of the picture: just the URL, never an image or any other kind of address. Leave it out to keep what is stored; send `null` to clear it.",
        example: "https://cdn.example.com/avatars/ana.png",
      }),
    ),
  ),
} as const;

const ProfileEntry = s.object({ identity: IdentityInput, ...ProfileFields }, { description: "One person and what to store about them." });

/** What `storage.profiles.upsert` takes from the fields of a request: only what was sent. */
export function profileChange(fields: { displayName?: string | null | undefined; email?: string | null | undefined; avatarUrl?: string | null | undefined }) {
  return {
    ...(fields.displayName !== undefined ? { displayName: fields.displayName } : {}),
    ...(fields.email !== undefined ? { email: fields.email } : {}),
    ...(fields.avatarUrl !== undefined ? { avatarUrl: fields.avatarUrl } : {}),
  };
}

export const profileRoutes = [
  defineRoute({
    id: "profiles.put",
    method: "PUT",
    path: "/v1/profiles",
    summary: "Store the profiles of your users",
    description:
      "Stores the display name, e-mail and avatar URL of up to 100 people, as your auth provider knows them, so Studio and the member reads show a person and not just an id. Call it where your backend already knows the user (after verifying their session), or in pages to backfill existing users. A field left out is KEPT as stored; `null` clears it; a person whose profile ends up empty has none stored. The same person has one profile in every organization, so this needs a client with every organization. Display data only: it never takes part in an authorization decision, and writing it is not audited (it can run on every sign-in). All the people of one call are stored together or not at all.",
    scope: "profiles:write",
    write: true,
    allOrganizations: true,
    body: s.object({ profiles: s.array(ProfileEntry, { min: 1, max: MAX_PROFILES_PER_CALL, description: "The people to store." }) }),
    response: s.object({
      stored: s.int({ min: 0, max: MAX_PROFILES_PER_CALL, description: "People who have a stored profile after the call." }),
      empty: s.int({ min: 0, max: MAX_PROFILES_PER_CALL, description: "People who have none: nothing was sent about them, or everything stored was cleared." }),
    }),
    errors: ["identity_provider_required", "identity_provider_reserved"],
    async handler(ctx, { body }) {
      // Completed first, so a bad identity refuses the whole call before anything is written.
      const entries = body.profiles.map((entry, index) => ({ identity: ctx.resolveIdentity(entry.identity, `profiles[${index}].identity`), entry }));
      const results = await ctx.application().storage.transaction(async (tx) => {
        const out: Array<Awaited<ReturnType<typeof tx.profiles.upsert>>> = [];
        for (const { identity, entry } of entries) {
          out.push(await tx.profiles.upsert(identity, profileChange(entry)));
        }
        return out;
      });
      const stored = results.filter((profile) => profile !== null).length;
      return { stored, empty: results.length - stored };
    },
  }),
];
