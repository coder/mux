/**
 * Extract a string message from an unknown error value.
 * Handles Error objects and other thrown values consistently.
 *
 * Walks the `.cause` chain so nested context (e.g. RuntimeError wrapping a
 * filesystem ENOENT) is surfaced rather than silently dropped.
 */
export function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    if (typeof error === "object" && error !== null) {
      try {
        const errorRecord = error as Record<string, unknown>;
        const message = errorRecord.message;
        if (typeof message === "string" && message.length > 0) {
          return message;
        }

        const serializedError = JSON.stringify(error);
        if (typeof serializedError === "string") {
          return serializedError;
        }
        // `JSON.stringify` can return undefined (for example when toJSON returns
        // undefined), so keep the string-return contract by falling back below.
      } catch {
        // Accessing properties on arbitrary thrown values (for example Proxies or
        // throwing getters) can itself throw. Keep this helper non-throwing and
        // fall back to String(error) below.
      }
    }

    return String(error);
  }

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
