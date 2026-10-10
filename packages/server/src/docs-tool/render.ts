import { API_SCOPES } from "@uniora/core";
import { statusForCode } from "../errors.js";
import type { Route } from "../route.js";
import type { Schema } from "../schema.js";
import type { Recorded } from "./run.js";

// ---------------------------------------------------------------------------------------------------------------------
// Making a real run reproducible: the ids and moments a server makes up are replaced by stable stand-ins, in order of appearance.

export function createNormalizer(): (text: string) => string {
  const maps = { derived: new Map<string, string>(), uuid: new Map<string, string>(), request: new Map<string, string>(), client: new Map<string, string>(), hex: new Map<string, string>(), audit: new Map<string, string>(), token: new Map<string, string>() };
  const stand = (map: Map<string, string>, value: string, make: (n: number) => string) => {
    if (!map.has(value)) map.set(value, make(map.size + 1));
    return map.get(value)!;
  };
  const pad = (n: number, width: number) => String(n).padStart(width, "0");
  let moments = 0;
  return (text) =>
    text
      .replace(/uniora_sk_[A-Za-z0-9_-]+/g, "uniora_sk_EXAMPLE")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (value) => stand(maps.uuid, value, (n) => `00000000-0000-4000-8000-${pad(n, 12)}`))
      .replace(/req_[A-Za-z0-9_-]{16}/g, (value) => stand(maps.request, value, (n) => `req_${pad(n, 16).replace(/0/g, "x")}`.slice(0, 20)))
      // The ids derived from an Idempotency-Key also depend on the (random) API client.
      .replace(/\b(org|role|mem)_[A-Za-z0-9_-]{24}(?![A-Za-z0-9_-])/g, (value, kind: string) => stand(maps.derived, value, (n) => `${kind}_EXAMPLE${pad(n, 4)}`.padEnd(kind.length + 25, "_")))
      .replace(/apc_[A-Za-z0-9]{16}/g, (value) => stand(maps.client, value, (n) => `apc_EXAMPLE${pad(n, 5)}`))
      .replace(/(?<="id": ")audit:[A-Za-z0-9_-]+/g, (value) => stand(maps.audit, value, (n) => `audit:EXAMPLE${pad(n, 4)}`))
      .replace(/\b[0-9a-f]{64}\b/g, (value) => stand(maps.hex, value, (n) => pad(n, 64).replace(/0/g, "a")))
      .replace(/"keyId": "[A-Za-z0-9]{16}"/g, '"keyId": "EXAMPLEKEYID0001"')
      // A cursor is opaque: it only names a position.
      .replace(/"nextCursor": "[A-Za-z0-9_-]{20,}"/g, '"nextCursor": "EXAMPLE_OPAQUE_CURSOR"')
      // The secret of an invitation link.
      .replace(/uinv_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, (value) => stand(maps.token, value, (n) => `uinv_EXAMPLE_TOKEN_${pad(n, 2)}`.padEnd(48, "_")))
      // A moment the server made up (the ones the example authored are far in the future and stay as written).
      .replace(/\b(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z/g, (value, year: string) => {
        if (Number(year) >= 2090) return value;
        const at = new Date(Date.UTC(2026, 2, 2, 9, 0, 0) + moments++ * 60_000);
        return at.toISOString();
      });
}

// ---------------------------------------------------------------------------------------------------------------------
// Fields

interface Row {
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}

const unwrap = (schema: Schema): { inner: Schema; optional: boolean; nullable: boolean } => {
  let inner = schema;
  let optional = false;
  let nullable = false;
  for (;;) {
    if (inner.kind === "optional") {
      optional = true;
      inner = inner.inner;
    } else if (inner.kind === "nullable") {
      nullable = true;
      inner = inner.inner;
    } else return { inner, optional, nullable };
  }
};

const describeType = (schema: Schema): string => {
  switch (schema.kind) {
    case "string":
      return `string${schema.min !== undefined ? ` (${schema.min}–${schema.max} chars)` : ` (≤ ${schema.max} chars)`}`;
    case "int":
      return `integer (${schema.min}–${schema.max === Number.MAX_SAFE_INTEGER ? "…" : schema.max})`;
    case "bool":
      return "boolean";
    case "date":
      return "string (date-time)";
    case "enum":
      return schema.values.map((value) => `\`${value}\``).join(" \\| ");
    case "array":
      return `array (≤ ${schema.max})`;
    case "object":
      return "object";
    case "record":
      return "object (free keys)";
    case "json":
      return "any JSON";
    default:
      return "";
  }
};

function rows(schema: Schema | undefined, prefix = "", depth = 0): Row[] {
  if (!schema) return [];
  const { inner } = unwrap(schema);
  if (inner.kind !== "object") return [];
  const out: Row[] = [];
  for (const [key, field] of Object.entries(inner.shape)) {
    const { inner: type, optional, nullable } = unwrap(field);
    const description = (type as { description?: string }).description ?? (field as { description?: string }).description ?? "";
    out.push({ field: `${prefix}${key}`, type: `${describeType(type)}${nullable ? " or `null`" : ""}`, required: !optional, description: description.replace(/\|/g, "\\|").replace(/\n/g, " ") });
    if (depth < 3) {
      if (type.kind === "object") out.push(...rows(type, `${prefix}${key}.`, depth + 1));
      else if (type.kind === "array" && unwrap(type.item).inner.kind === "object") out.push(...rows(type.item, `${prefix}${key}[].`, depth + 1));
    }
  }
  return out;
}

const table = (items: Row[], withRequired: boolean): string => {
  if (items.length === 0) return "";
  const header = withRequired ? "| Field | Type | Required | Description |\n| --- | --- | --- | --- |" : "| Field | Type | Description |\n| --- | --- | --- |";
  const body = items.map((row) => (withRequired ? `| \`${row.field}\` | ${row.type} | ${row.required ? "yes" : "no"} | ${row.description} |` : `| \`${row.field}\` | ${row.type}${row.required ? "" : ", may be absent"} | ${row.description} |`));
  return `${header}\n${body.join("\n")}\n`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Code

const js = (value: unknown, indent = ""): string => {
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const flat = `[${value.map((item) => js(item, next)).join(", ")}]`;
    return flat.length <= 72 && !flat.includes("\n") ? flat : `[\n${value.map((item) => `${next}${js(item, next)},`).join("\n")}\n${indent}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const key = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name));
    const flat = `{ ${entries.map(([name, item]) => `${key(name)}: ${js(item, next)}`).join(", ")} }`;
    return flat.length <= 72 && !flat.includes("\n") ? flat : `{\n${entries.map(([name, item]) => `${next}${key(name)}: ${js(item, next)},`).join("\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
};

const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

function curl(item: Recorded): string {
  const lines = [`curl -X ${item.request.method} "https://uniora.example.com${item.request.path}"`];
  if (item.step.as !== "anonymous") lines.push(`  -H "Authorization: Bearer $UNIORA_API_KEY"`);
  for (const [name, value] of Object.entries(item.request.headers)) lines.push(`  -H ${shellQuote(`${name}: ${value}`)}`);
  if (item.request.body !== undefined) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d ${shellQuote(JSON.stringify(item.request.body, null, 2).replace(/\n/g, "\n  "))}`);
  }
  return lines.join(" \\\n");
}

function clientSnippet(item: Recorded): string {
  const [group, method] = item.route.id.split(".") as [string, string];
  const call = `uniora.${group}.${method}`;
  const options: string[] = [];
  if (item.step.actor !== undefined) options.push(`actor: { subject: ${JSON.stringify(item.step.actor)} }`);
  const match = item.request.headers["If-Match"];
  if (match) options.push(`ifMatch: ${match.replace(/"/g, "")}`);
  if (item.step.idempotencyKey) options.push(`idempotencyKey: ${JSON.stringify(item.step.idempotencyKey)}`);
  const input = Object.keys(item.input).length > 0 ? js(item.input) : undefined;
  const args = [input, options.length > 0 ? `{ ${options.join(", ")} }` : undefined].filter((part): part is string => part !== undefined);
  const result = item.response.status < 300 ? "const result = " : "";
  const text = `${result}await ${call}(${args.join(", ")});`;
  if (text.length <= 100 || args.length === 0) return text;
  return `${result}await ${call}(\n${args.map((arg) => `  ${arg.replace(/\n/g, "\n  ")},`).join("\n")}\n);`;
}

function responseBlock(item: Recorded): string {
  const reason = { 200: "OK", 201: "Created", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 412: "Precondition Failed", 422: "Unprocessable Content" }[item.response.status] ?? "";
  const headers = Object.entries(item.response.headers).map(([name, value]) => `${name}: ${value}`);
  const body = item.response.body === undefined ? "" : `\n\n${JSON.stringify(item.response.body, null, 2)}`;
  return `HTTP/1.1 ${item.response.status} ${reason}${headers.length > 0 ? `\n${headers.join("\n")}` : ""}${body}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The document

const GROUPS: readonly { id: string; title: string; about: string; prefixes: readonly string[] }[] = [
  { id: "decisions", title: "Decisions", about: "Ask whether a user may do something. Application calls: your backend asks about any user.", prefixes: ["decisions"] },
  { id: "organizations", title: "Organizations", about: "Read organizations, and create one with its first Owner.", prefixes: ["organizations"] },
  { id: "members", title: "Members", about: "An organization's members, and what an end user may change about them.", prefixes: ["members"] },
  { id: "roles", title: "Roles", about: "Roles and the permissions they hold.", prefixes: ["roles"] },
  { id: "catalog", title: "Catalog", about: "The permissions and features registered in the deployment.", prefixes: ["permissions", "features"] },
  { id: "teams", title: "Teams", about: "Teams, their tree and their members.", prefixes: ["teams", "teamMembers"] },
  { id: "policies", title: "Policies", about: "Conditional rules that restrict what roles allow.", prefixes: ["policies"] },
  { id: "invitations", title: "Invitations", about: "Invite people, and the accept flow your server relays.", prefixes: ["invitations"] },
  { id: "audit", title: "Audit log", about: "The tamper-evident history of an organization.", prefixes: ["audit"] },
];

const STATUS_OF: Readonly<Record<string, number>> = {
  invalid_request: 400,
  invalid_cursor: 400,
  actor_required: 400,
  identity_provider_required: 400,
  identity_provider_reserved: 400,
  forbidden: 403,
  organization_not_found: 404,
  invitation_not_found: 404,
  actor_token_unsupported: 501,
  invitations_not_configured: 501,
  idempotency_key_reused: 422,
  idempotency_in_progress: 409,
};
const statusOf = (route: Route, code: string): number => (code === "invalid_invitation" ? (route.id === "invitations.preview" ? 404 : 400) : (STATUS_OF[code] ?? statusForCode(code)));

const slug = (route: Route): string => route.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function operationSection(route: Route, examples: readonly Recorded[]): string {
  const out: string[] = [];
  out.push(`### \`${route.method} ${route.path}\`  <a id="${slug(route)}"></a>`);
  out.push("");
  out.push(`**${route.summary}** · operation \`${route.id}\``);
  out.push("");
  out.push(route.description);
  out.push("");
  out.push(
    [
      `- **Scope:** \`${route.scope}\`${route.delegated ? " and `actor:assert`" : ""}`,
      `- **Kind:** ${route.delegated ? "delegated (speaks for an end user)" : "application (your backend asks as itself)"}`,
      `- **Changes data:** ${route.write ? "yes (refused with `503 read_only` while the server is read-only)" : "no"}`,
      ...(route.allOrganizations ? ["- **Client:** one that may reach every organization (`*`)"] : []),
      ...(route.ifMatch ? ["- **`If-Match`:** send the version you last saw; a stale one is a `412` and nothing changes"] : []),
      ...(route.etag ? ["- **`ETag`:** the answer carries the version of the resource"] : []),
      ...(route.idempotent ? ["- **`Idempotency-Key`:** accepted, so a retry cannot repeat the change"] : []),
    ].join("\n"),
  );
  out.push("");
  const request = [...rows(route.params, "").map((row) => ({ ...row, field: row.field, description: `(in the path) ${row.description}`.trim() })), ...rows(route.query).map((row) => ({ ...row, description: `(query) ${row.description}`.trim() })), ...rows(route.body)];
  if (request.length > 0) {
    out.push("**Request**");
    out.push("");
    out.push(table(request, true));
  }
  if (route.delegated) {
    out.push("Delegated calls also send `Uniora-Actor-Subject` (the end user, percent-encoded) and, when your server has no default label, `Uniora-Actor-Provider`.");
    out.push("");
  }
  const response = route.status === 204 ? [] : rows(route.response);
  out.push(`**Response \`${route.status}\`**`);
  out.push("");
  out.push(response.length > 0 ? table(response, false) : "");
  const errors = [...new Set(route.errors)].map((code) => ({ code, status: statusOf(route, code) })).sort((a, b) => a.status - b.status || a.code.localeCompare(b.code));
  if (errors.length > 0) {
    out.push("**Errors of this operation** (besides the ones every call can meet: see [Errors](#errors))");
    out.push("");
    out.push(errors.map((error) => `- \`${error.status}\` \`${error.code}\``).join("\n"));
    out.push("");
  }
  for (const item of examples) {
    out.push(`**Example: ${item.step.title}**`);
    out.push("");
    out.push("```bash");
    out.push(curl(item));
    out.push("```");
    out.push("");
    out.push("```ts");
    out.push(clientSnippet(item));
    out.push("```");
    out.push("");
    out.push("```http");
    out.push(responseBlock(item));
    out.push("```");
    out.push("");
  }
  return out.join("\n");
}

const INTRO = `# The UNIORA API reference

> Generated from the route table of \`@uniora/server\` and from a run against a real server. Do not edit by hand:
> \`UPDATE_DOCS=1 pnpm --filter @uniora/server test\` regenerates it, and a test fails when it is out of date. Every example below
> was executed; the response shown is what the server answered. The machine-readable contract is [\`openapi.json\`](openapi.json).
> How to run the server and the flows end to end are in the [server guide](server.md).

## Conventions

- **Transport.** HTTPS and JSON. Send \`Content-Type: application/json\` on anything with a body. Paths live under \`/v1\`. Plain HTTP is only for a server on the same machine.
- **Authentication.** \`Authorization: Bearer uniora_sk_…\` on every call under \`/v1\`. A key belongs to an **API client**, which has **scopes** and a list of **organizations**; a call outside them is refused. Keys are created in Studio or with \`uniora server keys create\`: there is no route that creates or changes one.
- **Application and delegated calls.** An application call is your backend asking as itself (decisions, reads, creating an organization). A **delegated** call changes things on behalf of an end user, who travels in \`Uniora-Actor-Subject\` (percent-encoded) and, if the server has no default label, \`Uniora-Actor-Provider\`. It needs the \`actor:assert\` scope too, and it succeeds only if that user may do it: a key can never do more than the user it speaks for. Never copy the actor from what the end user sent.
- **Identities.** \`{ "subject": "…" }\` is the user's id in your auth provider. \`provider\` is an opaque label you choose (it does not have to name your vendor); leave it out and the server's default label is used. The labels \`uniora-api\`, \`uniora-studio\`, \`uniora-cli\` and \`uniora-platform\` are reserved.
- **Versions.** Resources that change carry a \`version\`. It is also the \`ETag\` (quoted). Send it back as \`If-Match\` to refuse an edit made from a stale copy (\`412\`).
- **Idempotency.** Operations that create something accept \`Idempotency-Key\` (1–128 letters, digits and \`._:-\`). The same key with the same request answers the first result and does nothing again; the same key with a different request is refused. Keys are per API client.
- **Pagination.** Lists answer \`{ "items": [...], "nextCursor": "…" | null }\`. Pass \`nextCursor\` back as \`cursor\`. \`limit\` is at most 100. A cursor is opaque and only names a position.
- **Dates** are RFC 3339 in UTC.
- **Request ids.** Every answer has a \`Request-Id\` header and every error body a \`requestId\`; the detail of a failure is in the server's log under it.

## Errors <a id="errors"></a>

Errors are \`application/problem+json\` (RFC 9457):

\`\`\`json
{
  "type": "urn:uniora:error:forbidden",
  "title": "Forbidden",
  "status": 403,
  "code": "forbidden",
  "requestId": "req_xxxxxxxxxxxxxxxx"
}
\`\`\`

\`code\` is stable and only ever added: branch on it, never on \`title\`. **No internal message is ever returned**: a message can name an identity or an organization, and your backend may forward errors to a browser. A \`403\` never says why. On \`400 invalid_request\` the body also lists \`errors: [{ "path", "code" }]\`: where the input is wrong and why, never the value.

| Status | \`code\` | Meaning |
| --- | --- | --- |
| 400 | \`invalid_request\`, \`invalid_json\`, \`unexpected_body\`, \`invalid_cursor\` | The request is not acceptable. Unknown fields are refused, not ignored. |
| 400 | \`actor_required\`, \`identity_provider_required\`, \`identity_provider_reserved\` | A delegated call without a usable actor, or an identity with no provider label and no server default. |
| 401 | \`unauthenticated\` | No key, or one that is not valid: unknown, wrong, revoked, expired and disabled all answer the same. |
| 403 | \`forbidden\` | The client lacks the scope, the end user lacks the permission, or the target is out of reach. Never says which. |
| 403 | \`access_self_change\`, \`access_escalation\`, \`access_target_stronger\`, \`access_owner_protected\` | One of the four anti-escalation rules stopped a user who had the permission. |
| 404 | \`organization_not_found\` and the \`*_not_found\` of each resource | An organization outside the client's list answers exactly like one that does not exist. |
| 409 | \`*_exists\`, \`last_owner\`, \`idempotency_in_progress\`… | A conflict with the current state. |
| 412 | \`*_version_conflict\` | \`If-Match\` named a version that is no longer current. |
| 413, 415 | \`body_too_large\`, \`unsupported_media_type\` | Bodies are at most 64 KB and must be JSON. |
| 422 | \`idempotency_key_reused\` | The key was used for a different request. |
| 429 | \`rate_limited\` | Too many requests, per key or per source after failed authentications. \`Retry-After\` says when. |
| 500 | \`internal_error\` | A bug or a failure of the server. Nothing was exposed; quote the \`requestId\`. |
| 501 | \`actor_token_unsupported\`, \`invitations_not_configured\` | Not available in this deployment. |
| 503 | \`overloaded\`, \`timeout\`, \`unavailable\`, \`read_only\` | The server cannot take this now. \`Retry-After\` when it knows. |

## Scopes

| Scope | Allows |
| --- | --- |
${Object.entries(API_SCOPES)
  .map(([scope, meta]) => `| \`${scope}\` | ${meta.description}${meta.sensitive ? " **Sensitive.**" : ""} |`)
  .join("\n")}
`;

export function renderReference(recorded: readonly Recorded[], routes: readonly Route[]): string {
  const normalize = createNormalizer();
  const byOperation = new Map<string, Recorded[]>();
  for (const item of recorded) byOperation.set(item.route.id, [...(byOperation.get(item.route.id) ?? []), item]);

  const sections: string[] = [];
  const index: string[] = [];
  for (const group of GROUPS) {
    const members = routes.filter((route) => group.prefixes.includes(route.id.split(".")[0]!));
    if (members.length === 0) continue;
    sections.push(`## ${group.title}\n\n${group.about}\n`);
    index.push(`- **${group.title}**`);
    for (const route of members) {
      index.push(`  - [\`${route.method} ${route.path}\`](#${slug(route)}): ${route.summary}`);
      sections.push(operationSection(route, byOperation.get(route.id) ?? []));
    }
  }
  // One pass over the whole text, in reading order, so the same id gets the same stand-in everywhere.
  return normalize(`${INTRO}\n## Operations\n\n${index.join("\n")}\n\n${sections.join("\n")}`).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
