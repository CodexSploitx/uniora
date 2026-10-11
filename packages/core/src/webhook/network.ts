import { isIPv4, isIPv6 } from "node:net";
import { WebhookError } from "./errors.js";

/** `a.b.c.d` as a 32-bit number. */
function v4(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

/** [network, prefix length]: every IPv4 range that is not the public internet. */
const PRIVATE_V4: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, and the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved and broadcast
];

function privateV4(address: string): boolean {
  const value = v4(address);
  return PRIVATE_V4.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((v4(network) & mask) >>> 0);
  });
}

/** The 16 bytes of an IPv6 address, or `null` if it is not one. */
function bytesOfV6(address: string): number[] | null {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!isIPv6(address.split("%")[0]!)) return null;
  // An embedded IPv4 tail (`::ffff:1.2.3.4`) becomes two groups.
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const value = v4(tail[1]!);
    text = `${text.slice(0, tail.index)}${((value >>> 16) & 0xffff).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = rest === undefined || rest === "" ? [] : rest.split(":");
  const groups = rest === undefined ? front : [...front, ...Array<string>(8 - front.length - back.length).fill("0"), ...back];
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => {
    const value = parseInt(group, 16);
    return [(value >>> 8) & 0xff, value & 0xff];
  });
}

/**
 * Whether `address` (an IPv4 or IPv6 literal, as DNS or a URL gives it) is on the public internet. Everything else is refused as a
 * webhook target: loopback, the private ranges, link-local (the cloud metadata service lives there), carrier-grade NAT, multicast,
 * documentation and transition addresses that embed one of those (`::ffff:10.0.0.1`, `64:ff9b::7f00:1`, 6to4). An address that is not
 * an IP at all is not public either: the caller decides what to do with names.
 */
export function isPublicIp(address: string): boolean {
  if (isIPv4(address)) return !privateV4(address);
  const bytes = bytesOfV6(address);
  if (!bytes) return false;
  const embedded = (offset: number) => `${bytes[offset]}.${bytes[offset + 1]}.${bytes[offset + 2]}.${bytes[offset + 3]}`;
  if (bytes.every((byte) => byte === 0)) return false; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return false; // ::1
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return !privateV4(embedded(12)); // ::ffff:a.b.c.d
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return false; // deprecated IPv4-compatible ::a.b.c.d
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && bytes.slice(4, 12).every((byte) => byte === 0)) return !privateV4(embedded(12)); // NAT64
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return !privateV4(embedded(2)); // 6to4
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return false; // Teredo
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false; // documentation
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((byte) => byte === 0)) return false; // discard 100::/64
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // unique local fc00::/7
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // link-local fe80::/10
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0xc0) return false; // site-local fec0::/10
  if (bytes[0] === 0xff) return false; // multicast
  return true;
}

export const MAX_WEBHOOK_URL_LENGTH = 2000;

export interface WebhookUrlPolicy {
  /** Allow `http:` (a development receiver). Default `false`: a webhook body travels over TLS. */
  allowInsecureHttp?: boolean;
  /** Allow names and addresses on private networks, loopback included (a development receiver, or one inside your own network). Default `false`. */
  allowPrivateNetworks?: boolean;
}

const BLOCKED_NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/**
 * Checks everything about a webhook URL that can be known without the network: `https:` (or `http:` when allowed), no credentials in
 * it, no fragment, a host that is not an obviously internal name or a private/loopback address literal. It is the first line of the
 * SSRF defense, applied when an endpoint is registered; the delivery worker checks again against the addresses the name RESOLVES to,
 * at the moment of every delivery, because a name can be pointed at an internal address after it was registered.
 */
export function parseWebhookUrl(value: unknown, policy: WebhookUrlPolicy = {}): URL {
  const invalid = (reason: string) => new WebhookError(`The webhook URL ${reason}.`, "webhook_url_invalid");
  if (typeof value !== "string" || value === "" || value.length > MAX_WEBHOOK_URL_LENGTH) throw invalid(`must be a text of at most ${MAX_WEBHOOK_URL_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f]/.test(value)) throw invalid("cannot contain spaces or control characters");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("is not a URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && policy.allowInsecureHttp === true)) throw invalid(policy.allowInsecureHttp === true ? "must be http or https" : "must be https");
  if (url.username !== "" || url.password !== "") throw invalid("cannot carry credentials: put a secret in the path or sign the body instead");
  if (url.hash !== "") throw invalid("cannot have a fragment");
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") throw invalid("needs a host");
  if (policy.allowPrivateNetworks !== true) {
    const literal = isIPv4(host) || isIPv6(host);
    if (literal && !isPublicIp(host)) throw invalid("points at a private, loopback or link-local address");
    // `0x7f.1`, `2130706433`, `127.1`: WHATWG URL already turned these into dotted form, so what is left that looks numeric is refused.
    if (!literal && /^[0-9.x]+$/i.test(host)) throw invalid("is not a valid host");
    if (!literal && BLOCKED_NAMES.test(host)) throw invalid("points at an internal name");
    if (!literal && !host.includes(".")) throw invalid("needs a fully qualified host name");
  }
  return url;
}
