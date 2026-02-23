/**
 * Extract a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 *
 * Walks the `.cause` chain so nested context (e.g. RuntimeError wrapping a
 * filesystem ENOENT) is surfaced rather than silently dropped.
 */
export function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  let msg = error.message;
  // Guard against cyclic cause chains (e.g. err.cause = err) with a visited set.
  const seen = new WeakSet<Error>();
  seen.add(error);
  let current: unknown = error.cause;
  while (current instanceof Error) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current.message && !msg.includes(current.message)) {
      msg += ` [cause: ${current.message}]`;
    }
    current = current.cause;
  }
  return msg;
}
