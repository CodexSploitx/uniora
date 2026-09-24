import type { MessageKey } from "@/i18n/translate";

export type FieldKey = Extract<MessageKey, `field.${string}`>;
export type InputErrorCode = "required" | "mustBeText" | "tooLong" | "mustBeList";

/** Carries a code + field label key instead of a sentence; it is translated where the response is built. */
export class InputError extends Error {
  constructor(
    readonly code: InputErrorCode,
    readonly field: FieldKey,
  ) {
    super(`${code}: ${field}`);
    this.name = "InputError";
  }
}

/** A Studio-authored, user-facing failure identified by a translation key. */
export class StudioError extends Error {
  constructor(readonly key: Extract<MessageKey, `errors.${string}`>) {
    super(key);
    this.name = "StudioError";
  }
}

/** Every action argument arrives from the browser: never trust its type or size. */
export function text(value: unknown, field: FieldKey, options: { max?: number; optional?: false }): string;
export function text(value: unknown, field: FieldKey, options: { max?: number; optional: true }): string | undefined;
export function text(value: unknown, field: FieldKey, options: { max?: number; optional?: boolean } = {}): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.optional) return undefined;
    throw new InputError("required", field);
  }
  if (typeof value !== "string") throw new InputError("mustBeText", field);
  const trimmed = value.trim();
  if (!trimmed) {
    if (options.optional) return undefined;
    throw new InputError("required", field);
  }
  if (trimmed.length > (options.max ?? 255)) throw new InputError("tooLong", field);
  return trimmed;
}

export function textList(value: unknown, field: FieldKey): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new InputError("mustBeList", field);
  return value.map((item) => text(item, field, { max: 128 }));
}
