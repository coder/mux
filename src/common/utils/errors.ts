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
  let current: unknown = error.cause;
  while (current instanceof Error) {
    if (current.message && !msg.includes(current.message)) {
      msg += ` [cause: ${current.message}]`;
    }
    current = current.cause;
  }
  return msg;
}
