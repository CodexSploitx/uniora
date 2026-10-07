/**
 * Validates an `expectedVersion` passed to an optimistic-concurrency check. `undefined` means "no check". Anything
 * else must be a positive integer: a `0`, a fraction or a string would never match a stored version, and silently
 * turning that into a conflict would hide a caller bug.
 */
export function assertExpectedVersion(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("expectedVersion must be a positive integer (the `version` you read).");
  }
  return value;
}
