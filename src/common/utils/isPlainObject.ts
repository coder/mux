/**
 * Type guard that checks whether a value is a plain object (created via `{}`,
 * `Object.create(null)`, or `new Object()`).  Rejects arrays, class instances,
 * `null`, and primitives.
 *
 * Duplicated across many files in the codebase — prefer importing this shared
 * version for new code.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
