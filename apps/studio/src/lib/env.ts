import "server-only";

export interface StudioEnv {
  databaseUrl: string;
  token: string;
  readOnly: boolean;
  /** From `auth.provider` in `uniora.config.mjs`, if set — pre-fills the "owner/member provider" fields. Never validated further: a host app may use more than one provider. */
  defaultAuthProvider?: string;
}

/** Read from the environment the CLI (`npx uniora studio`) launched us with. Never sent to the client. */
export function getStudioEnv(): StudioEnv {
  const databaseUrl = process.env.UNIORA_STUDIO_DATABASE_URL;
  const token = process.env.UNIORA_STUDIO_TOKEN;
  if (!databaseUrl || !token) {
    throw new Error("Studio is not configured. Launch it with `npx uniora studio`.");
  }
  return {
    databaseUrl,
    token,
    readOnly: process.env.UNIORA_STUDIO_READ_ONLY === "1",
    defaultAuthProvider: process.env.UNIORA_STUDIO_AUTH_PROVIDER || undefined,
  };
}
