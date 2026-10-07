/**
 * Validates an `expectedVersion` passed to an optimistic-concurrency check. `undefined` means "no check". Anything
 * else must be a positive integer (or, with `minimum = 0`, a whole number from 0): a `0`, a fraction or a string would never match a stored version, and silently
 * turning that into a conflict would hide a caller bug.
 */
export function assertExpectedVersion(value: number | undefined, minimum = 1): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(
      minimum === 0
        ? "expectedVersion must be a whole number, 0 or more (the `version` you read; 0 means no override yet)."
        : "expectedVersion must be a positive integer (the `version` you read).",
    );
  }
  return value;
}
