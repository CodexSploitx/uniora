/**
 * A tiny schema language for the API, with no dependency. One definition does three jobs, so they cannot drift apart:
 *
 * - `parseInput`: validates what a caller sent, STRICTLY (an unknown field is an error, never ignored) and converts dates.
 * - `project`: shapes what the server answers, keeping ONLY the declared fields. A field the handler happened to hold
 *   (a digest, an internal flag, a column added next year) can therefore never leave the server by accident.
 * - `toJsonSchema`: the description used to generate the OpenAPI document.
 *
 * Everything is bounded by construction: a string, an array, an integer and a free-form object cannot be declared without
 * its limits, so an unbounded field is a compile error, not a code-review catch.
 */

interface Base {
  readonly description?: string;
  readonly example?: unknown;
}
export interface StringSchema extends Base {
  readonly kind: "string";
  readonly max: number;
  readonly min?: number;
  readonly pattern?: RegExp;
}
export interface IntSchema extends Base {
  readonly kind: "int";
  readonly min: number;
  readonly max: number;
}
export interface BoolSchema extends Base {
  readonly kind: "bool";
}
/** An RFC 3339 moment. In a request it arrives as text and becomes a `Date`; in a response a `Date` becomes text. */
export interface DateSchema extends Base {
  readonly kind: "date";
}
export interface EnumSchema<V extends readonly string[] = readonly string[]> extends Base {
  readonly kind: "enum";
  readonly values: V;
}
export interface ArraySchema<I extends Schema = Schema> extends Base {
  readonly kind: "array";
  readonly item: I;
  readonly max: number;
  readonly min?: number;
}
export interface ObjectSchema<Sh extends Readonly<Record<string, Schema>> = Readonly<Record<string, Schema>>> extends Base {
  readonly kind: "object";
  readonly shape: Sh;
}
/** An object with caller-chosen keys (attributes, context signals). */
export interface RecordSchema<V extends Schema = Schema> extends Base {
  readonly kind: "record";
  readonly value: V;
  readonly maxKeys: number;
  readonly keyPattern: RegExp;
}
/** Any JSON value, bounded in depth, size and string length. For data UNIORA only passes along (resource attributes, context). */
export interface JsonSchema extends Base {
  readonly kind: "json";
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxString: number;
}
export interface OptionalSchema<I extends Schema = Schema> {
  readonly kind: "optional";
  readonly inner: I;
}
export interface NullableSchema<I extends Schema = Schema> {
  readonly kind: "nullable";
  readonly inner: I;
}

export type Schema =
  | StringSchema
  | IntSchema
  | BoolSchema
  | DateSchema
  | EnumSchema
  | ArraySchema
  | ObjectSchema
  | RecordSchema
  | JsonSchema
  | OptionalSchema
  | NullableSchema;

// ---------------------------------------------------------------------------------------------------------------------
// Builders

export const s = {
  string: (options: { max: number; min?: number; pattern?: RegExp; description?: string; example?: unknown }): StringSchema => ({ kind: "string", ...options }),
  int: (options: { min: number; max: number; description?: string; example?: unknown }): IntSchema => ({ kind: "int", ...options }),
  bool: (options: { description?: string; example?: unknown } = {}): BoolSchema => ({ kind: "bool", ...options }),
  date: (options: { description?: string; example?: unknown } = {}): DateSchema => ({ kind: "date", ...options }),
  enum: <const V extends readonly string[]>(values: V, options: { description?: string; example?: unknown } = {}): EnumSchema<V> => ({
    kind: "enum",
    values,
    ...options,
  }),
  array: <I extends Schema>(item: I, options: { max: number; min?: number; description?: string; example?: unknown }): ArraySchema<I> => ({
    kind: "array",
    item,
    ...options,
  }),
  object: <const Sh extends Readonly<Record<string, Schema>>>(shape: Sh, options: { description?: string; example?: unknown } = {}): ObjectSchema<Sh> => ({
    kind: "object",
    shape,
    ...options,
  }),
  record: <V extends Schema>(value: V, options: { maxKeys: number; keyPattern: RegExp; description?: string; example?: unknown }): RecordSchema<V> => ({
    kind: "record",
    value,
    ...options,
  }),
  json: (options: { maxDepth: number; maxNodes: number; maxString: number; description?: string; example?: unknown }): JsonSchema => ({ kind: "json", ...options }),
  optional: <I extends Schema>(inner: I): OptionalSchema<I> => ({ kind: "optional", inner }),
  nullable: <I extends Schema>(inner: I): NullableSchema<I> => ({ kind: "nullable", inner }),
};

// ---------------------------------------------------------------------------------------------------------------------
// Static types

type OptionalKeys<Sh> = { [K in keyof Sh]: Sh[K] extends { readonly kind: "optional" } ? K : never }[keyof Sh];
type RequiredKeys<Sh> = Exclude<keyof Sh, OptionalKeys<Sh>>;
type Id<T> = T extends object ? { [K in keyof T]: T[K] } : T;

/**
 * The TypeScript type of a value that satisfies `S` (after `parseInput`, or what a handler must return for `project`).
 * A "wide" schema (the `Schema` union itself, or an object whose keys are not known) says nothing specific about the value
 * and is `unknown`: without that guard, inference through the recursive union never terminates.
 */
export type Infer<S> = [Schema] extends [S]
  ? unknown
  : S extends { readonly kind: "string" }
    ? string
    : S extends { readonly kind: "int" }
      ? number
      : S extends { readonly kind: "bool" }
        ? boolean
        : S extends { readonly kind: "date" }
          ? Date
          : S extends { readonly kind: "enum"; readonly values: readonly (infer V)[] }
            ? V
            : S extends { readonly kind: "array"; readonly item: infer I }
              ? [Schema] extends [I]
                ? unknown[]
                : Infer<I>[]
              : S extends { readonly kind: "object"; readonly shape: infer Sh }
                ? string extends keyof Sh
                  ? Record<string, unknown>
                  : Id<{ [K in RequiredKeys<Sh>]: Infer<Sh[K]> } & { [K in OptionalKeys<Sh>]?: InferOptional<Sh[K]> }>
                : S extends { readonly kind: "record"; readonly value: infer V }
                  ? Record<string, Infer<V>>
                  : S extends { readonly kind: "json" }
                    ? unknown
                    : S extends { readonly kind: "nullable"; readonly inner: infer I }
                      ? Infer<I> | null
                      : never;

type InferOptional<S> = S extends { readonly kind: "optional"; readonly inner: infer I } ? Infer<I> : never;

// ---------------------------------------------------------------------------------------------------------------------
// Parsing a request

export interface Issue {
  /** Where, e.g. `identity.subject` or `checks[3].permission`. Never the value: a value may be a secret. */
  readonly path: string;
  readonly code:
    | "required"
    | "unknown_field"
    | "type"
    | "too_long"
    | "too_short"
    | "out_of_range"
    | "pattern"
    | "enum"
    | "too_many"
    | "invalid_date"
    | "invalid_key"
    | "too_deep"
    | "too_large";
}

export type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly issues: readonly Issue[] };

const MAX_ISSUES = 20;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

class Collector {
  readonly issues: Issue[] = [];
  add(path: string, code: Issue["code"]): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, code });
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const join = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

/** Validates `value` against `schema`. Strict: every unknown field is an issue. */
export function parseInput<S extends Schema>(schema: S, value: unknown): ParseResult<Infer<S>> {
  const collector = new Collector();
  const parsed = parse(schema, value, "", collector);
  return collector.issues.length === 0 ? { ok: true, value: parsed as Infer<S> } : { ok: false, issues: collector.issues };
}

function parse(schema: Schema, value: unknown, path: string, out: Collector): unknown {
  switch (schema.kind) {
    case "optional":
      return value === undefined ? undefined : parse(schema.inner, value, path, out);
    case "nullable":
      return value === null ? null : parse(schema.inner, value, path, out);
    case "string": {
      if (typeof value !== "string") return void out.add(path, value === undefined ? "required" : "type");
      if (value.length > schema.max) return void out.add(path, "too_long");
      if (schema.min !== undefined && value.length < schema.min) return void out.add(path, "too_short");
      if (CONTROL.test(value)) return void out.add(path, "pattern");
      if (schema.pattern && !schema.pattern.test(value)) return void out.add(path, "pattern");
      return value;
    }
    case "int": {
      if (typeof value !== "number") return void out.add(path, value === undefined ? "required" : "type");
      if (!Number.isInteger(value)) return void out.add(path, "type");
      if (value < schema.min || value > schema.max) return void out.add(path, "out_of_range");
      return value;
    }
    case "bool":
      if (typeof value !== "boolean") return void out.add(path, value === undefined ? "required" : "type");
      return value;
    case "date": {
      if (typeof value !== "string") return void out.add(path, value === undefined ? "required" : "type");
      if (value.length > 40 || !RFC3339.test(value)) return void out.add(path, "invalid_date");
      const time = Date.parse(value);
      if (!Number.isFinite(time)) return void out.add(path, "invalid_date");
      return new Date(time);
    }
    case "enum":
      if (typeof value !== "string") return void out.add(path, value === undefined ? "required" : "type");
      if (!schema.values.includes(value)) return void out.add(path, "enum");
      return value;
    case "array": {
      if (!Array.isArray(value)) return void out.add(path, value === undefined ? "required" : "type");
      if (value.length > schema.max) return void out.add(path, "too_many");
      if (schema.min !== undefined && value.length < schema.min) return void out.add(path, "too_short");
      return value.map((item, index) => parse(schema.item, item, `${path}[${index}]`, out));
    }
    case "object": {
      if (value === undefined) return void out.add(path, "required");
      if (!isPlainObject(value)) return void out.add(path, "type");
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.shape, key)) out.add(join(path, key), "unknown_field");
      }
      for (const [key, inner] of Object.entries(schema.shape)) {
        const parsed = parse(inner, Object.hasOwn(value, key) ? value[key] : undefined, join(path, key), out);
        if (parsed !== undefined) result[key] = parsed;
      }
      return result;
    }
    case "record": {
      if (value === undefined) return void out.add(path, "required");
      if (!isPlainObject(value)) return void out.add(path, "type");
      const keys = Object.keys(value);
      if (keys.length > schema.maxKeys) return void out.add(path, "too_many");
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        if (FORBIDDEN_KEYS.has(key) || !schema.keyPattern.test(key)) {
          out.add(join(path, "<key>"), "invalid_key");
          continue;
        }
        result[key] = parse(schema.value, value[key], join(path, key), out);
      }
      return result;
    }
    case "json": {
      const budget = { nodes: 0 };
      const parsed = parseJson(schema, value, 0, budget, path, out);
      return parsed;
    }
  }
}

function parseJson(schema: JsonSchema, value: unknown, depth: number, budget: { nodes: number }, path: string, out: Collector): unknown {
  if (++budget.nodes > schema.maxNodes) return void out.add(path, "too_large");
  if (depth > schema.maxDepth) return void out.add(path, "too_deep");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : void out.add(path, "type");
  if (typeof value === "string") return value.length <= schema.maxString ? value : void out.add(path, "too_long");
  if (Array.isArray(value)) {
    if (value.length > schema.maxNodes) return void out.add(path, "too_many");
    return value.map((item, index) => parseJson(schema, item, depth + 1, budget, `${path}[${index}]`, out));
  }
  if (isPlainObject(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key) || key.length > 64 || CONTROL.test(key)) {
        out.add(join(path, "<key>"), "invalid_key");
        continue;
      }
      result[key] = parseJson(schema, value[key], depth + 1, budget, join(path, key), out);
    }
    return result;
  }
  return void out.add(path, "type");
}

// ---------------------------------------------------------------------------------------------------------------------
// Shaping a response

/** The handler returned something that does not fit the declared response: a bug in the server, never a client error. */
export class ResponseShapeError extends Error {
  constructor(readonly path: string, readonly problem: string) {
    super(`The response does not match its schema at "${path || "<root>"}": ${problem}.`);
    this.name = "ResponseShapeError";
  }
}

/** Keeps exactly the declared fields of `value`, with dates as text. Anything not declared is dropped; a declared field that is missing or of the wrong type throws. */
export function project(schema: Schema, value: unknown, path = ""): unknown {
  switch (schema.kind) {
    case "optional":
      return value === undefined ? undefined : project(schema.inner, value, path);
    case "nullable":
      return value === null ? null : project(schema.inner, value, path);
    case "string":
      if (typeof value !== "string") throw new ResponseShapeError(path, "expected a string");
      return value;
    case "int":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new ResponseShapeError(path, "expected a number");
      return value;
    case "bool":
      if (typeof value !== "boolean") throw new ResponseShapeError(path, "expected a boolean");
      return value;
    case "date": {
      // A command layer already answers in JSON (dates as ISO text); a service answers with `Date`s. Both are shaped the same way.
      const time = value instanceof Date ? value.getTime() : typeof value === "string" && RFC3339.test(value) ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(time)) throw new ResponseShapeError(path, "expected a valid date");
      return new Date(time).toISOString();
    }
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) throw new ResponseShapeError(path, "expected one of the declared values");
      return value;
    case "array":
      if (!Array.isArray(value)) throw new ResponseShapeError(path, "expected an array");
      return value.map((item, index) => project(schema.item, item, `${path}[${index}]`));
    case "object": {
      if (typeof value !== "object" || value === null) throw new ResponseShapeError(path, "expected an object");
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(schema.shape)) {
        const projected = project(inner, source[key], join(path, key));
        if (projected !== undefined) result[key] = projected;
      }
      return result;
    }
    case "record": {
      if (typeof value !== "object" || value === null) throw new ResponseShapeError(path, "expected an object");
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        result[key] = project(schema.value, item, join(path, key));
      }
      return result;
    }
    case "json":
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAPI

export type JsonSchemaObject = Record<string, unknown>;

/** The JSON Schema (OpenAPI 3.1 flavour) of `schema`. */
export function toJsonSchema(schema: Schema): JsonSchemaObject {
  const documented = (base: JsonSchemaObject, source: Schema): JsonSchemaObject => {
    const { description, example } = source as Base;
    return { ...base, ...(description ? { description } : {}), ...(example !== undefined ? { examples: [example] } : {}) };
  };
  switch (schema.kind) {
    case "optional":
      return toJsonSchema(schema.inner);
    case "nullable": {
      const inner = toJsonSchema(schema.inner);
      const type = inner.type;
      return { ...inner, type: Array.isArray(type) ? [...type, "null"] : [type, "null"] };
    }
    case "string":
      return documented(
        {
          type: "string",
          maxLength: schema.max,
          ...(schema.min !== undefined ? { minLength: schema.min } : {}),
          ...(schema.pattern ? { pattern: schema.pattern.source } : {}),
        },
        schema,
      );
    case "int":
      return documented({ type: "integer", minimum: schema.min, maximum: schema.max }, schema);
    case "bool":
      return documented({ type: "boolean" }, schema);
    case "date":
      return documented({ type: "string", format: "date-time" }, schema);
    case "enum":
      return documented({ type: "string", enum: [...schema.values] }, schema);
    case "array":
      return documented(
        { type: "array", items: toJsonSchema(schema.item), maxItems: schema.max, ...(schema.min !== undefined ? { minItems: schema.min } : {}) },
        schema,
      );
    case "object": {
      const required = Object.entries(schema.shape)
        .filter(([, inner]) => inner.kind !== "optional")
        .map(([key]) => key);
      return documented(
        {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(Object.entries(schema.shape).map(([key, inner]) => [key, toJsonSchema(inner)])),
          ...(required.length > 0 ? { required } : {}),
        },
        schema,
      );
    }
    case "record":
      return documented(
        {
          type: "object",
          maxProperties: schema.maxKeys,
          propertyNames: { pattern: schema.keyPattern.source },
          additionalProperties: toJsonSchema(schema.value),
        },
        schema,
      );
    case "json":
      return documented({ description: `Any JSON value, at most ${schema.maxDepth} levels deep and ${schema.maxNodes} values.` }, schema);
  }
}
