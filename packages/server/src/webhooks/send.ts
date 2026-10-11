import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { isPublicIp } from "@uniora/core";
import type { WebhookUrlPolicy } from "@uniora/core";

export interface SendWebhookInput {
  url: string;
  /** The exact bytes that were signed. */
  body: string;
  headers: Readonly<Record<string, string>>;
  timeoutMs: number;
  policy?: WebhookUrlPolicy;
  /** Replace the DNS lookup (tests). */
  resolve?: (host: string) => Promise<readonly string[]>;
}

export interface SendWebhookResult {
  /** `true` for a 2xx answer. */
  readonly ok: boolean;
  readonly status?: number;
  readonly durationMs: number;
  /** Why it failed, in words that name neither the URL nor the answer. */
  readonly error?: string;
  /** What the receiver asked to wait (`Retry-After`), in seconds, when it said so on a 429 or 503. */
  readonly retryAfterSeconds?: number;
}

/** Most of an answer worth reading: the status and a few headers are all UNIORA uses, and a hostile receiver can stream forever. */
const MAX_RESPONSE_BYTES = 4096;

const defaultResolve = async (host: string): Promise<readonly string[]> => (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * The address a delivery connects to. A literal IP is checked as it is; a name is RESOLVED HERE, every address it resolves to must be
 * public, and the connection then goes to the address that was checked, not to the name (which could resolve differently a moment
 * later: DNS rebinding). With `allowPrivateNetworks` nothing is refused.
 */
async function destinationOf(host: string, policy: WebhookUrlPolicy, resolve: NonNullable<SendWebhookInput["resolve"]>): Promise<string> {
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) {
    if (policy.allowPrivateNetworks !== true && !isPublicIp(bare)) throw new Error("the address is not public");
    return bare;
  }
  const addresses = await resolve(bare);
  if (addresses.length === 0) throw new Error("the name does not resolve");
  if (policy.allowPrivateNetworks !== true && addresses.some((address) => !isPublicIp(address))) throw new Error("the name resolves to a private address");
  return addresses[0]!;
}

function describe(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  switch (code) {
    case "ECONNREFUSED":
      return "connection refused";
    case "ECONNRESET":
    case "EPIPE":
      return "connection reset";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the name does not resolve";
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "the host is unreachable";
    case "CERT_HAS_EXPIRED":
      return "TLS: the certificate has expired";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "TLS: the certificate is not for this host";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
      return "TLS: the certificate is not trusted";
  }
  const message = error instanceof Error ? error.message : "";
  // Only our own short reasons (thrown above) are repeated; anything else from the platform could carry an address or a host.
  return /^the (address|name) /.test(message) ? message : typeof code === "string" && /^[A-Z0-9_]{3,40}$/.test(code) ? `network error ${code}` : "network error";
}

/**
 * One POST of a webhook, hardened as a client of strangers' servers: it only goes to public addresses (checked when it is sent, on the
 * address it will really use), never follows a redirect, has a total deadline, reads at most a few KB of the answer, keeps no
 * connection open afterwards, and verifies TLS against the host name (not the address it connected to).
 */
export async function sendWebhook(input: SendWebhookInput): Promise<SendWebhookResult> {
  const started = Date.now();
  const policy = input.policy ?? {};
  const url = new URL(input.url);
  const elapsed = () => Date.now() - started;
  let address: string;
  try {
    // The lookup is inside the deadline too: a name server that never answers must not hold a delivery (and the worker) for ever.
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("the name does not resolve")), input.timeoutMs);
    });
    try {
      address = await Promise.race([destinationOf(url.hostname, policy, input.resolve ?? defaultResolve), late]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, durationMs: elapsed(), error: describe(error) };
  }

  return new Promise<SendWebhookResult>((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (result: Omit<SendWebhookResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ ...result, durationMs: elapsed() });
    };
    const secure = url.protocol === "https:";
    let request: ReturnType<typeof httpRequest>;
    try {
      request = (secure ? httpsRequest : httpRequest)(
      {
        host: address,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        method: "POST",
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: { ...input.headers, host: url.host, "content-length": String(Buffer.byteLength(input.body)), connection: "close" },
        // The certificate is checked against the NAME in the URL, not the address connected to (a literal IP is checked as it is).
        ...(secure ? { minVersion: "TLSv1.2" as const, ...(isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0 ? { servername: url.hostname } : {}) } : {}),
      },
      (response) => {
        // A 2xx is the answer: whatever the receiver streams after it is not read (nor waited for: a delivery that was accepted is not retried).
        if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300) {
          finish({ ok: true, status: response.statusCode ?? 200 });
          response.destroy();
          return;
        }
        let read = 0;
        response.on("data", (chunk: Buffer) => {
          read += chunk.length;
          if (read > MAX_RESPONSE_BYTES) response.destroy();
        });
        const done = () => {
          const status = response.statusCode ?? 0;
          const retryAfter = Number(response.headers["retry-after"]);
          if (status >= 200 && status < 300) return finish({ ok: true, status });
          finish({
            ok: false,
            status,
            error: status >= 300 && status < 400 ? `HTTP ${status}: redirects are not followed` : `HTTP ${status}`,
            ...((status === 429 || status === 503) && Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.min(3600, Math.ceil(retryAfter)) } : {}),
          });
        };
        response.on("end", done);
        response.on("close", done);
        response.on("error", done);
      },
    );
    } catch {
      // The HTTP client refused what it was given (a header it cannot send): a failed attempt, never an exception that stops the worker.
      finish({ ok: false, error: "the request could not be sent" });
      return;
    }
    deadline = setTimeout(() => {
      request.destroy();
      finish({ ok: false, error: `timeout after ${input.timeoutMs} ms` });
    }, input.timeoutMs);
    request.on("error", (error) => finish({ ok: false, error: describe(error) }));
    request.end(input.body);
  });
}
