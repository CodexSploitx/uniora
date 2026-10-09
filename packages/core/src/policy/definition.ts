import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical-json.js";
import { assertValidFeatureKey } from "../feature/key.js";
import { assertValidPermissionKey } from "../permission/key.js";
import {
  RESERVED_NAMESPACES,
  RESOURCE_ATTRIBUTES,
  SUBJECT_ATTRIBUTES,
  isBuiltinResourceAttribute,
  isProtectedPermission,
  isSubjectAttribute,
} from "./attributes.js";
import { PolicyError } from "./errors.js";
import { ATTRIBUTE_TYPES, COMPARISONS, POLICY_EFFECTS, POLICY_KINDS, RESERVED_POLICY_KINDS } from "./types.js";
import type { AttributeType, AttributeValue, Comparison, Condition, Operand, PolicyDefinition, PolicyEffect, PolicyKind } from "./types.js";

/** Hard limits of a definition. They bound the cost of evaluating it and the size of what is stored. */
export const MAX_POLICY_ACTIONS = 32;
export const MAX_POLICY_ATTRIBUTES = 32;
export const MAX_CONDITION_NODES = 64;
export const MAX_CONDITION_DEPTH = 8;
export const MAX_CONDITION_CHILDREN = 16;
export const MAX_LITERAL_LENGTH = 256;
export const MAX_LITERAL_ITEMS = 100;
export const MAX_POLICY_DEFINITION_BYTES = 16 * 1024;
export const MAX_POLICY_FACT_LOOKUPS = 16;
export const MAX_POLICY_KEY_LENGTH = 100;
export const MAX_POLICY_NAME_LENGTH = 255;
export const MAX_POLICY_DESCRIPTION_LENGTH = 1000;
export const MAX_POLICY_NOTE_LENGTH = 500;

const KEY_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ATTRIBUTE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]{0,63}$/;
const PREFIX_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*\.\*$/;

const bad = (message: string): never => {
  throw new PolicyError(message, "policy_definition_invalid");
};

/** What a definition reads and how big it is: used to check the kind, to prefetch facts and to bound the evaluation. */
export interface PolicyAnalysis {
  /** Feature keys the condition asks about. */
  features: string[];
  /** Permission keys the condition asks about. */
  permissions: string[];
  subjectRefs: string[];
  resourceRefs: string[];
  nodes: number;
  depth: number;
}

export interface ParsedPolicyDefinition {
  /** The normalized definition: keys in a fixed order, actions and attributes sorted. This is what gets stored. */
  definition: PolicyDefinition;
  /** SHA-256 hex of the canonical JSON of `definition`. */
  hash: string;
  analysis: PolicyAnalysis;
}

export function hashPolicyDefinition(definition: PolicyDefinition): string {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 1: take untrusted input apart into plain JSON. Rejects everything that is not plain data BEFORE any rule is read.
// ---------------------------------------------------------------------------------------------------------------------

const SNAPSHOT_MAX_DEPTH = 24;
const SNAPSHOT_MAX_NODES = 4000;

function snapshot(value: unknown, state: { nodes: number }, depth: number, path: string): unknown {
  if (++state.nodes > SNAPSHOT_MAX_NODES) bad("The definition is too large.");
  if (depth > SNAPSHOT_MAX_DEPTH) bad(`${path}: nested too deeply.`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 2000) bad(`${path}: text is too long.`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad(`${path}: numbers must be finite.`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1000) bad(`${path}: list is too long.`);
    const out: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) bad(`${path}[${index}]: holes are not allowed.`);
      out.push(snapshot(value[index], state, depth + 1, `${path}[${index}]`));
    }
    return out;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) bad(`${path}: must be a plain object.`);
    if (Object.getOwnPropertySymbols(value).length > 0) bad(`${path}: symbol keys are not allowed.`);
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") bad(`${path}: the key "${key}" is not allowed.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) bad(`${path}.${key}: accessors are not allowed.`);
      // An `undefined` property is an absent one (JSON.stringify drops it too).
      if (descriptor!.value === undefined) continue;
      out[key] = snapshot(descriptor!.value, state, depth + 1, `${path}.${key}`);
    }
    return out;
  }
  return bad(`${path}: unsupported value (${typeof value}).`);
}

function asObject(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) bad(`${path} must be an object.`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) bad(`${path}: unknown field "${key}".`);
  }
  for (const key of required) {
    if (object[key] === undefined) bad(`${path}: "${key}" is required.`);
  }
  return object;
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 2: the rules.
// ---------------------------------------------------------------------------------------------------------------------

function parseActions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) return bad("actions must be a non-empty list of permission keys.");
  if (value.length > MAX_POLICY_ACTIONS) bad(`actions can list at most ${MAX_POLICY_ACTIONS} entries.`);
  const seen = new Set<string>();
  for (const action of value) {
    if (typeof action !== "string") bad("every action must be a text.");
    const text = action as string;
    if (text === "*") {
      seen.add(text);
      continue;
    }
    if (PREFIX_PATTERN.test(text)) {
      if (text.length > 150) bad(`action "${text}" is too long.`);
      if (isProtectedPermission(text.slice(0, -1))) bad(`action "${text}": policies are never evaluated for the policy administration permissions (policies.*).`);
      seen.add(text);
      continue;
    }
    try {
      assertValidPermissionKey(text);
    } catch {
      return bad(`action "${text.slice(0, 80)}" must be a permission key ("vehicles.update"), a prefix ("vehicles.*") or "*".`);
    }
    if (isProtectedPermission(text)) bad(`action "${text}": policies are never evaluated for the policy administration permissions (policies.*).`);
    seen.add(text);
  }
  return [...seen].sort();
}

function parseAttributes(value: unknown): Record<string, AttributeType> | undefined {
  if (value === undefined) return undefined;
  const object = asObject(value, "attributes", Object.keys(value as object));
  const names = Object.keys(object).sort();
  if (names.length > MAX_POLICY_ATTRIBUTES) bad(`attributes can declare at most ${MAX_POLICY_ATTRIBUTES} entries.`);
  const out: Record<string, AttributeType> = {};
  for (const name of names) {
    if (!ATTRIBUTE_NAME_PATTERN.test(name)) bad(`attribute name "${name.slice(0, 40)}" must start with a lowercase letter and use letters, digits and underscores (at most 64 characters).`);
    if (isBuiltinResourceAttribute(`resource.${name}`)) bad(`attribute "${name}" is built in; it cannot be declared.`);
    const type = object[name];
    if (typeof type !== "string" || !(ATTRIBUTE_TYPES as readonly string[]).includes(type)) {
      bad(`attribute "${name}" must have one of the types: ${ATTRIBUTE_TYPES.join(", ")}.`);
    }
    out[name] = type as AttributeType;
  }
  return out;
}

function literalType(value: unknown, path: string): AttributeType {
  if (typeof value === "string") {
    if (value.length > MAX_LITERAL_LENGTH) bad(`${path}: text literals can have at most ${MAX_LITERAL_LENGTH} characters.`);
    return "string";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (Array.isArray(value)) {
    if (value.length === 0) bad(`${path}: a list literal cannot be empty (its type would be ambiguous).`);
    if (value.length > MAX_LITERAL_ITEMS) bad(`${path}: a list literal can have at most ${MAX_LITERAL_ITEMS} items.`);
    const first = typeof value[0];
    if (first !== "string" && first !== "number") bad(`${path}: a list literal holds texts or numbers.`);
    for (const item of value) {
      if (typeof item !== first) bad(`${path}: every item of a list literal must have the same type.`);
      if (typeof item === "string" && item.length > MAX_LITERAL_LENGTH) bad(`${path}: text literals can have at most ${MAX_LITERAL_LENGTH} characters.`);
    }
    return first === "string" ? "string[]" : "number[]";
  }
  return bad(`${path}: a literal must be a text, a number, a boolean or a list of texts or numbers.`);
}

interface ParseState {
  nodes: number;
  maxDepth: number;
  attributes: Record<string, AttributeType>;
  hasResourceType: boolean;
  features: Set<string>;
  permissions: Set<string>;
  subjectRefs: Set<string>;
  resourceRefs: Set<string>;
}

function refType(ref: string, state: ParseState, path: string): AttributeType {
  const namespace = ref.split(".", 1)[0] ?? "";
  if ((RESERVED_NAMESPACES as readonly string[]).includes(namespace)) {
    bad(`${path}: "${namespace}.*" attributes are reserved for contextual policies, which are designed but not available yet.`);
  }
  if (isSubjectAttribute(ref)) {
    state.subjectRefs.add(ref);
    return SUBJECT_ATTRIBUTES[ref];
  }
  if (ref.startsWith("resource.")) {
    if (!state.hasResourceType) bad(`${path}: reading ${ref} needs the policy to declare a resourceType.`);
    state.resourceRefs.add(ref);
    if (isBuiltinResourceAttribute(ref)) return RESOURCE_ATTRIBUTES[ref as keyof typeof RESOURCE_ATTRIBUTES];
    const declared = state.attributes[ref.slice("resource.".length)];
    if (declared === undefined) bad(`${path}: ${ref} is not declared in "attributes".`);
    return declared!;
  }
  return bad(`${path}: unknown attribute "${ref.slice(0, 60)}". Use subject.* or resource.*.`);
}

function parseOperand(value: unknown, state: ParseState, path: string): { operand: Operand; type: AttributeType } {
  const object = asObject(value, path, ["ref", "value"]);
  const keys = Object.keys(object);
  if (keys.length !== 1) bad(`${path} must have exactly one of "ref" or "value".`);
  state.nodes++;
  if (keys[0] === "ref") {
    if (typeof object.ref !== "string") bad(`${path}.ref must be a text.`);
    const ref = object.ref as string;
    return { operand: { ref }, type: refType(ref, state, `${path}.ref`) };
  }
  const type = literalType(object.value, `${path}.value`);
  return { operand: { value: object.value as AttributeValue }, type };
}

const SCALAR_TYPES: readonly AttributeType[] = ["string", "number", "boolean"];
const elementOf = (type: AttributeType): AttributeType | null => (type === "string[]" ? "string" : type === "number[]" ? "number" : null);

function checkComparison(op: Comparison, left: AttributeType, right: AttributeType, path: string): void {
  const mismatch = (): never => bad(`${path}: "${op}" cannot compare ${left} with ${right}.`);
  switch (op) {
    case "eq":
    case "neq":
      if (!SCALAR_TYPES.includes(left) || left !== right) mismatch();
      break;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (left !== "number" || right !== "number") mismatch();
      break;
    case "in":
      if (!SCALAR_TYPES.includes(left) || left === "boolean" || elementOf(right) !== left) mismatch();
      break;
    case "contains":
      if (elementOf(left) === null || elementOf(left) !== right) mismatch();
      break;
    case "intersects":
      if (elementOf(left) === null || left !== right) mismatch();
      break;
  }
}

function parseCondition(value: unknown, state: ParseState, depth: number, path: string): Condition {
  if (depth > MAX_CONDITION_DEPTH) bad(`${path}: conditions can be nested at most ${MAX_CONDITION_DEPTH} levels.`);
  if (++state.nodes > MAX_CONDITION_NODES) bad(`The condition is too large (at most ${MAX_CONDITION_NODES} nodes, counting operands).`);
  state.maxDepth = Math.max(state.maxDepth, depth);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return bad(`${path} must be an object with exactly one operator.`);
  const keys = Object.keys(value);
  if (keys.length !== 1) bad(`${path} must have exactly one operator (found ${keys.length}).`);
  const operator = keys[0]!;
  const body = (value as Record<string, unknown>)[operator];
  const here = `${path}.${operator}`;

  if (operator === "all" || operator === "any") {
    if (!Array.isArray(body) || body.length === 0) return bad(`${here} must be a non-empty list of conditions.`);
    if (body.length > MAX_CONDITION_CHILDREN) bad(`${here} can combine at most ${MAX_CONDITION_CHILDREN} conditions.`);
    const children = body.map((child, index) => parseCondition(child, state, depth + 1, `${here}[${index}]`));
    return operator === "all" ? { all: children } : { any: children };
  }
  if (operator === "not") return { not: parseCondition(body, state, depth + 1, here) };
  if (operator === "exists") {
    if (typeof body !== "string") return bad(`${here} must be the name of an attribute.`);
    state.nodes++;
    refType(body, state, here);
    return { exists: body };
  }
  if (operator === "feature") {
    if (typeof body !== "string") return bad(`${here} must be a feature key.`);
    try {
      assertValidFeatureKey(body);
    } catch {
      return bad(`${here}: "${body.slice(0, 60)}" is not a valid feature key.`);
    }
    state.features.add(body);
    return { feature: body };
  }
  if (operator === "permission") {
    if (typeof body !== "string") return bad(`${here} must be a permission key.`);
    try {
      assertValidPermissionKey(body);
    } catch {
      return bad(`${here}: "${body.slice(0, 60)}" is not a valid permission key.`);
    }
    state.permissions.add(body);
    return { permission: body };
  }
  if ((COMPARISONS as readonly string[]).includes(operator)) {
    if (!Array.isArray(body) || body.length !== 2) return bad(`${here} must be a pair [left, right].`);
    const left = parseOperand(body[0], state, `${here}[0]`);
    const right = parseOperand(body[1], state, `${here}[1]`);
    checkComparison(operator as Comparison, left.type, right.type, here);
    return { [operator]: [left.operand, right.operand] } as unknown as Condition;
  }
  return bad(`${path}: unknown operator "${operator.slice(0, 40)}". Use all, any, not, exists, feature, permission, ${COMPARISONS.join(", ")}.`);
}

/**
 * Turns untrusted input (a JSON body, a file, an import) into a normalized definition, or throws `policy_definition_invalid`
 * with the path of the problem. It is the only way a definition gets in: the repositories store only what this returns.
 *
 * Nothing in a definition is executed: it is parsed as data against a fixed grammar, every attribute it reads must be a
 * built-in one or declared with a type, unknown fields are errors, and the size, depth and number of lookups are bounded.
 */
export function parsePolicyDefinition(input: unknown): ParsedPolicyDefinition {
  const plain = snapshot(input, { nodes: 0 }, 0, "definition");
  const root = asObject(plain, "definition", ["kind", "effect", "actions", "resourceType", "attributes", "condition", "denyReason"], ["kind", "effect", "actions", "condition"]);

  const kind = root.kind;
  if (typeof kind === "string" && (RESERVED_POLICY_KINDS as readonly string[]).includes(kind)) {
    bad(`The "${kind}" kind is designed but not available yet.`);
  }
  if (typeof kind !== "string" || !(POLICY_KINDS as readonly string[]).includes(kind)) bad(`kind must be one of: ${POLICY_KINDS.join(", ")}.`);
  const effect = root.effect;
  if (typeof effect !== "string" || !(POLICY_EFFECTS as readonly string[]).includes(effect)) {
    bad(effect === "allow" ? 'effect "allow" does not exist: a policy cannot grant anything. Use "deny" or "require".' : `effect must be one of: ${POLICY_EFFECTS.join(", ")}.`);
  }
  const actions = parseActions(root.actions);

  let resourceType: string | undefined;
  if (root.resourceType !== undefined) {
    if (typeof root.resourceType !== "string" || !RESOURCE_TYPE_PATTERN.test(root.resourceType)) {
      bad("resourceType must start with a lowercase letter and use lowercase letters, digits, '.', '_' or '-' (at most 64 characters).");
    }
    resourceType = root.resourceType as string;
  }
  const attributes = parseAttributes(root.attributes);
  if (attributes && Object.keys(attributes).length > 0 && resourceType === undefined) bad("Declaring resource attributes needs a resourceType.");

  let denyReason: string | undefined;
  if (root.denyReason !== undefined) {
    if (typeof root.denyReason !== "string" || !CODE_PATTERN.test(root.denyReason)) {
      bad("denyReason must be a short code: a lowercase letter then lowercase letters, digits, '_', '.' or '-' (at most 64 characters).");
    }
    denyReason = root.denyReason as string;
  }

  const state: ParseState = {
    nodes: 0,
    maxDepth: 0,
    attributes: attributes ?? {},
    hasResourceType: resourceType !== undefined,
    features: new Set(),
    permissions: new Set(),
    subjectRefs: new Set(),
    resourceRefs: new Set(),
  };
  const condition = parseCondition(root.condition, state, 1, "condition");
  if (state.features.size + state.permissions.size > MAX_POLICY_FACT_LOOKUPS) {
    bad(`A condition can ask about at most ${MAX_POLICY_FACT_LOOKUPS} features and permissions in total.`);
  }
  const declaredButUnused = Object.keys(attributes ?? {}).filter((name) => !state.resourceRefs.has(`resource.${name}`));
  if (declaredButUnused.length > 0) bad(`attribute "${declaredButUnused[0]}" is declared but the condition never reads it.`);

  checkKind(kind as PolicyKind, resourceType, state);

  const definition: PolicyDefinition = {
    kind: kind as PolicyKind,
    effect: effect as PolicyEffect,
    actions,
    ...(resourceType !== undefined ? { resourceType } : {}),
    ...(attributes !== undefined && Object.keys(attributes).length > 0 ? { attributes } : {}),
    condition,
    ...(denyReason !== undefined ? { denyReason } : {}),
  };
  const json = canonicalJson(definition);
  if (Buffer.byteLength(json, "utf8") > MAX_POLICY_DEFINITION_BYTES) bad(`A definition can have at most ${MAX_POLICY_DEFINITION_BYTES} bytes of JSON.`);
  return {
    definition: JSON.parse(json) as PolicyDefinition,
    hash: createHash("sha256").update(json).digest("hex"),
    analysis: {
      features: [...state.features].sort(),
      permissions: [...state.permissions].sort(),
      subjectRefs: [...state.subjectRefs].sort(),
      resourceRefs: [...state.resourceRefs].sort(),
      nodes: state.nodes,
      depth: state.maxDepth,
    },
  };
}

/** A kind is a promise about what the definition looks at; a definition that breaks it is refused. */
function checkKind(kind: PolicyKind, resourceType: string | undefined, state: ParseState): void {
  switch (kind) {
    case "resource":
      if (resourceType === undefined) bad('A "resource" policy needs a resourceType.');
      if (![...state.resourceRefs].some((ref) => !isBuiltinResourceAttribute(ref))) bad('A "resource" policy must read at least one declared resource attribute.');
      break;
    case "scope":
      if (state.subjectRefs.size === 0 || state.resourceRefs.size === 0) bad('A "scope" policy must compare something about the person (subject.*) with something about the resource (resource.*).');
      break;
    case "feature":
      if (state.features.size === 0) bad('A "feature" policy must ask for at least one feature.');
      break;
    case "access":
      if ([...state.resourceRefs].some((ref) => !isBuiltinResourceAttribute(ref))) bad('An "access" policy does not read the state of the resource; use a "resource" policy for that.');
      break;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Small validators shared by the repositories and the service.
// ---------------------------------------------------------------------------------------------------------------------

export function assertValidPolicyKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_POLICY_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new PolicyError(
      `A policy key is lowercase letters and digits separated by '.', '_' or '-' (for example "vehicles.locked-readonly"), at most ${MAX_POLICY_KEY_LENGTH} characters.`,
      "policy_key_invalid",
    );
  }
  return key;
}

export function sanitizePolicyName(name: unknown): string {
  if (typeof name !== "string") throw new PolicyError("Policy name must be a string.", "policy_name_invalid");
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed === "") throw new PolicyError("Policy name cannot be empty.", "policy_name_invalid");
  if (trimmed.length > MAX_POLICY_NAME_LENGTH) throw new PolicyError(`Policy name cannot exceed ${MAX_POLICY_NAME_LENGTH} characters.`, "policy_name_invalid");
  return trimmed;
}

export function sanitizePolicyDescription(description: unknown): string | undefined {
  if (description === undefined) return undefined;
  if (typeof description !== "string") throw new PolicyError("Policy description must be a string.", "policy_description_invalid");
  const trimmed = description.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > MAX_POLICY_DESCRIPTION_LENGTH) {
    throw new PolicyError(`Policy description cannot exceed ${MAX_POLICY_DESCRIPTION_LENGTH} characters.`, "policy_description_invalid");
  }
  return trimmed;
}

/** A free-text reason or note: trimmed, cut at 500 characters, `undefined` when empty. */
export function sanitizePolicyNote(note: unknown): string | undefined {
  const trimmed = typeof note === "string" ? note.trim() : "";
  return trimmed === "" ? undefined : trimmed.slice(0, MAX_POLICY_NOTE_LENGTH);
}

/** Whether a policy with these `actions` applies to a request for `permission` (exact key, `a.b.*` prefix or `*`). */
export function actionMatches(actions: readonly string[], permission: string): boolean {
  if (isProtectedPermission(permission)) return false;
  for (const action of actions) {
    if (action === permission || action === "*") return true;
    if (action.endsWith(".*") && permission.startsWith(action.slice(0, -1))) return true;
  }
  return false;
}

/** The patterns that can match `permission`, from the most to the least specific: `a.b.c`, `a.b.*`, `a.*`, `*`. A backend looks policies up by these. */
export function actionCandidates(permission: string): string[] {
  const parts = permission.split(".");
  const out = [permission];
  for (let length = parts.length - 1; length >= 1; length--) out.push(`${parts.slice(0, length).join(".")}.*`);
  out.push("*");
  return out;
}
