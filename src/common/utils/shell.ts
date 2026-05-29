/**
 * Quote a string for safe use in shell commands.
 * Uses single quotes with proper escaping for embedded single quotes.
 *
 * @example
 * shellQuote("foo") // "'foo'"
 * shellQuote("it's") // "'it'\"'\"'s'"
 * shellQuote("") // "''"
 */
export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}
