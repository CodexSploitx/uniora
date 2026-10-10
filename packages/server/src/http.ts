import type { IncomingMessage, ServerResponse } from "node:http";
import { errors } from "./errors.js";
import type { Issue, ObjectSchema } from "./schema.js";

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

export interface SendOptions {
  readonly status: number;
  readonly requestId: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contentType?: string;
  /** Ask the client to close the connection afterwards (a request body we stopped reading). */
  readonly close?: boolean;
}

/** Writes a response once. A second call (a late handler after a timeout) is ignored. */
export function send(res: ServerResponse, body: unknown, options: SendOptions): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string | number> = {
    ...SECURITY_HEADERS,
    "Request-Id": options.requestId,
    ...(payload === "" ? {} : { "Content-Type": options.contentType ?? "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) }),
    ...options.headers,
  };
  if (options.close) headers.Connection = "close";
  res.writeHead(options.status, headers);
  res.end(payload);
}

const JSON_TYPE = /^application\/json\s*(?:;\s*charset\s*=\s*"?utf-8"?\s*)?$/i;

export function assertJsonContentType(req: IncomingMessage): void {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !JSON_TYPE.test(type)) throw errors.unsupportedMediaType();
}

/** True when the request declares or streams a body. */
export function hasBody(req: IncomingMessage): boolean {
  const length = req.headers["content-length"];
  return (length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined;
}

/**
 * Reads the whole body, refusing anything over `maxBytes` without buffering it: a declared length over the limit is refused
 * before one byte is read, and an undeclared (chunked) body is cut as soon as it crosses the limit.
 */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.pause();
      reject(errors.bodyTooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        req.pause();
        reject(errors.bodyTooLarge());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      reject(errors.invalidJson());
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
    req.once("aborted", onAborted);
  });
}

export function parseJsonBody(buffer: Buffer): unknown {
  if (buffer.length === 0) throw errors.invalidJson();
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw errors.invalidJson();
  }
}

/**
 * Query parameters as the strict object a schema expects. Each value is converted by what the field is declared to be
 * (`limit=10` to the integer 10, `active=true` to a boolean); a repeated parameter is refused rather than "the last one wins".
 */
export function queryToObject(schema: ObjectSchema | undefined, params: URLSearchParams): { value: Record<string, unknown>; issues: Issue[] } {
  const value: Record<string, unknown> = {};
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of params) {
    if (seen.has(key)) {
      issues.push({ path: key, code: "too_many" });
      continue;
    }
    seen.add(key);
    let field = schema?.shape[key];
    while (field && (field.kind === "optional" || field.kind === "nullable")) field = field.inner;
    if (field?.kind === "int") {
      value[key] = /^-?\d{1,15}$/.test(raw) ? Number(raw) : raw; // a non-number stays text and fails validation as a type error
    } else if (field?.kind === "bool") {
      value[key] = raw === "true" ? true : raw === "false" ? false : raw;
    } else {
      value[key] = raw;
    }
  }
  return { value, issues };
}
