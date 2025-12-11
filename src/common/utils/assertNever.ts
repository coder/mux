/**
 * Exhaustive type checking helper.
 * Use in switch/if-else chains to ensure all cases of a union are handled.
 *
 * @example
 * type Mode = "a" | "b" | "c";
 * function handle(mode: Mode) {
 *   switch (mode) {
 *     case "a": return 1;
 *     case "b": return 2;
 *     case "c": return 3;
 *     default: assertNever(mode); // Compile error if any case is missing
 *   }
 * }
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${String(value)}`);
}
