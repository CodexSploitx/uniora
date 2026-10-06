/**
 * `UNIORA_INVITE_URL` — where the invitee opens the invitation, with `{token}` marking where the secret goes,
 * e.g. `https://app.example.com/invite/{token}`. Returns `null` unless it is a safe, usable template.
 */
export function inviteUrlFactory(template: string | undefined): ((token: string) => string) | null {
  const value = template?.trim();
  if (!value || value.split("{token}").length !== 2) return null;
  let probe: URL;
  try {
    probe = new URL(value.replace("{token}", "probe-token"));
  } catch {
    return null;
  }
  if ((probe.protocol !== "https:" && probe.protocol !== "http:") || probe.username || probe.password) return null;
  // The secret belongs in the path or fragment, never the query string (proxies and analytics log those).
  if (probe.search.includes("probe-token")) return null;
  return (token) => value.replace("{token}", encodeURIComponent(token));
}
