/** Prefix that identifies a 1Password secret reference. */
export const OP_REF_PREFIX = "op://";

/** Type guard: returns true if `value` is a string starting with "op://". */
export function isOpReference(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(OP_REF_PREFIX);
}
