import { describe, expect, it } from "vitest";
import { endpointWants, generateWebhookSecret, isPublicIp, isWebhookSecret, parseWebhookUrl, signWebhook, verifyWebhook, webhookBackoffMs, webhookBody } from "../index.js";

describe("isPublicIp", () => {
  it.each([
    "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.63.255.255", "100.128.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888",
  ])("accepts the public address %s", (address) => expect(isPublicIp(address)).toBe(true));

  it.each([
    "0.0.0.0", "10.1.2.3", "127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255",
    "198.18.0.1", "168.63.129.16", "::ffff:0:7f00:1", "64:ff9b:1::7f00:1", "192.0.2.5", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:a00:1::",
    "fe80::1", "fe80::1%eth0", "fc00::1", "fd12:3456::1", "fec0::1", "ff02::1", "2001:db8::1", "2001:0::1", "100::1", "not an ip", "",
  ])("refuses %s", (address) => expect(isPublicIp(address)).toBe(false));

  it("tells embedded public IPv4 addresses from private ones", () => {
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIp("64:ff9b::808:808")).toBe(true);
    expect(isPublicIp("2002:808:808::1")).toBe(true);
  });
});

describe("parseWebhookUrl", () => {
  it("accepts an https URL with a path, a query and a port", () => {
    expect(parseWebhookUrl("https://hooks.example.com:8443/a/b?token=x").toString()).toBe("https://hooks.example.com:8443/a/b?token=x");
  });

  it.each([
    ["http://hooks.example.com/", "https"],
    ["ftp://hooks.example.com/", "https"],
    ["https://u:p@hooks.example.com/", "credentials"],
    ["https://hooks.example.com/#frag", "fragment"],
    ["https://127.0.0.1/", "private"],
    ["https://2130706433/", "private"],
    ["https://0x7f.1/", "private"],
    ["https://[::1]/", "private"],
    ["https://[::ffff:10.0.0.1]/", "private"],
    ["https://169.254.169.254/latest/meta-data", "private"],
    ["https://localhost/", "internal"],
    ["https://localhost./", "internal"],
    ["https://foo.localhost../", "internal"],
    ["https://metadata.google.internal./", "internal"],
    ["https://169.254.169.254./", "private"],
    ["https://168.63.129.16/", "private"],
    ["https://app.localhost/", "internal"],
    ["https://db.internal/", "internal"],
    ["https://printer.local/", "internal"],
    ["https://intranet/", "fully qualified"],
    ["https://exa mple.com/", "spaces"],
    ["", "text"],
    ["https://" + "a".repeat(2000) + ".com/", "at most"],
  ])("refuses %s", (value, why) => expect(() => parseWebhookUrl(value), value).toThrow(new RegExp(why)));

  it("lets a development setup through when asked", () => {
    expect(parseWebhookUrl("http://127.0.0.1:9000/hook", { allowInsecureHttp: true, allowPrivateNetworks: true }).hostname).toBe("127.0.0.1");
    expect(() => parseWebhookUrl("http://hooks.example.com/", { allowPrivateNetworks: true })).toThrow(/https/);
    expect(() => parseWebhookUrl("https://127.0.0.1/", { allowInsecureHttp: true })).toThrow(/private/);
  });
});

describe("signing", () => {
  const body = webhookBody({ id: "evt_1", type: "membership.blocked", organizationId: "org_1", createdAt: new Date("2030-01-01T00:00:00Z"), payload: { membershipId: "mem_1" } });

  it("makes secrets of the documented shape", () => {
    const secret = generateWebhookSecret();
    expect(isWebhookSecret(secret)).toBe(true);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(generateWebhookSecret()).not.toBe(secret);
    expect(isWebhookSecret("whsec_short")).toBe(false);
  });

  it("builds a stable envelope", () => {
    expect(JSON.parse(body)).toEqual({ id: "evt_1", type: "membership.blocked", organizationId: "org_1", createdAt: "2030-01-01T00:00:00.000Z", data: { membershipId: "mem_1" } });
    expect(JSON.parse(webhookBody({ id: "e", type: "t", createdAt: new Date(0) }))).toEqual({ id: "e", type: "t", createdAt: "1970-01-01T00:00:00.000Z", data: {} });
  });

  it("verifies what it signed, with the current secret or the previous one", () => {
    const current = generateWebhookSecret();
    const previous = generateWebhookSecret();
    const now = new Date("2030-01-01T00:00:10Z");
    const timestamp = Math.floor(now.getTime() / 1000) - 5;
    const signature = signWebhook([current, previous], "evt_1", timestamp, body);
    expect(signature.split(" ")).toHaveLength(2);
    const headers = { id: "evt_1", timestamp: String(timestamp), signature };
    expect(verifyWebhook({ body, headers, secrets: current, now })).toBe(true);
    expect(verifyWebhook({ body, headers, secrets: previous, now })).toBe(true);
    expect(verifyWebhook({ body, headers, secrets: [generateWebhookSecret(), current], now })).toBe(true);
  });

  it("refuses a changed body, id or timestamp, a stranger's secret, a replay and rubbish", () => {
    const secret = generateWebhookSecret();
    const now = new Date("2030-01-01T00:00:10Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhook([secret], "evt_1", timestamp, body);
    const ok = { id: "evt_1", timestamp: String(timestamp), signature };
    expect(verifyWebhook({ body: `${body} `, headers: ok, secrets: secret, now })).toBe(false);
    expect(verifyWebhook({ body, headers: { ...ok, id: "evt_2" }, secrets: secret, now })).toBe(false);
    expect(verifyWebhook({ body, headers: { ...ok, timestamp: String(timestamp + 1) }, secrets: secret, now })).toBe(false);
    expect(verifyWebhook({ body, headers: ok, secrets: generateWebhookSecret(), now })).toBe(false);
    expect(verifyWebhook({ body, headers: ok, secrets: secret, now: new Date(now.getTime() + 301_000) })).toBe(false); // replayed later
    expect(verifyWebhook({ body, headers: ok, secrets: secret, now: new Date(now.getTime() - 301_000) })).toBe(false); // from the future
    expect(verifyWebhook({ body, headers: ok, secrets: secret, now: new Date(now.getTime() + 301_000), toleranceSeconds: 600 })).toBe(true);
    for (const headers of [
      { id: undefined, timestamp: ok.timestamp, signature },
      { id: "evt_1", timestamp: undefined, signature },
      { id: "evt_1", timestamp: ok.timestamp, signature: undefined },
      { id: "evt_1", timestamp: "abc", signature },
      { id: "evt_1", timestamp: ok.timestamp, signature: "" },
      { id: "evt_1", timestamp: ok.timestamp, signature: "v2,AAAA" },
      { id: "evt_1", timestamp: ok.timestamp, signature: "v1," },
    ]) expect(verifyWebhook({ body, headers, secrets: secret, now })).toBe(false);
    expect(verifyWebhook({ body, headers: ok, secrets: ["nope"], now })).toBe(false);
  });

  it("refuses to verify when the tolerance is not a number, instead of accepting everything", () => {
    const secret = generateWebhookSecret();
    const old = Math.floor(Date.now() / 1000) - 10 * 86400;
    const signature = signWebhook([secret], "evt_1", old, body);
    const headers = { id: "evt_1", timestamp: String(old), signature };
    expect(verifyWebhook({ body, headers, secrets: secret })).toBe(false);
    for (const toleranceSeconds of [Number.NaN, Number(process.env.UNIORA_NOT_SET)]) expect(verifyWebhook({ body, headers, secrets: secret, toleranceSeconds })).toBe(false);
    expect(verifyWebhook({ body, headers, secrets: secret, toleranceSeconds: "300" as never })).toBe(false);
    expect(verifyWebhook({ body, headers, secrets: secret, toleranceSeconds: 11 * 86400 })).toBe(true);
  });

  it("refuses to sign without a secret or with a malformed one", () => {
    expect(() => signWebhook([], "e", 1, "x")).toThrow();
    expect(() => signWebhook(["whsec_nope"], "e", 1, "x")).toThrow();
  });
});

describe("routing an event", () => {
  const endpoint = (events: string[], organizations: "*" | string[] = "*") => ({ events, organizations });
  it("matches exact types, prefixes and everything", () => {
    const event = { type: "membership.blocked", organizationId: "org_1" };
    expect(endpointWants(endpoint(["membership.blocked"]), event)).toBe(true);
    expect(endpointWants(endpoint(["membership.*"]), event)).toBe(true);
    expect(endpointWants(endpoint(["*"]), event)).toBe(true);
    expect(endpointWants(endpoint(["membership"]), event)).toBe(false);
    expect(endpointWants(endpoint(["member.*"]), event)).toBe(false);
    expect(endpointWants(endpoint(["membership.block"]), event)).toBe(false);
    expect(endpointWants(endpoint(["role.*", "membership.*"]), event)).toBe(true);
    expect(endpointWants(endpoint(["membershipx.*"]), { type: "membership.blocked" })).toBe(false);
  });
  it("filters by organization, and a list never receives an event of no organization", () => {
    expect(endpointWants(endpoint(["*"], ["org_1"]), { type: "a.b", organizationId: "org_1" })).toBe(true);
    expect(endpointWants(endpoint(["*"], ["org_1"]), { type: "a.b", organizationId: "org_2" })).toBe(false);
    expect(endpointWants(endpoint(["*"], ["org_1"]), { type: "a.b" })).toBe(false);
    expect(endpointWants(endpoint(["*"], "*"), { type: "a.b" })).toBe(true);
  });
});

describe("backoff", () => {
  it("doubles from 30 s up to an hour, with bounded jitter", () => {
    expect(webhookBackoffMs(1, () => 0)).toBe(30_000);
    expect(webhookBackoffMs(2, () => 0)).toBe(60_000);
    expect(webhookBackoffMs(3, () => 0)).toBe(120_000);
    expect(webhookBackoffMs(20, () => 0)).toBe(3_600_000);
    expect(webhookBackoffMs(1, () => 1)).toBe(37_500);
    expect(webhookBackoffMs(20, () => 1)).toBe(4_500_000);
  });
});
