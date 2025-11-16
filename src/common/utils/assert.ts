// Browser-safe assertion helper for renderer and worker bundles.
// Throws immediately when invariants are violated so bugs surface early.
export class AssertionError extends Error {
  constructor(message?: string) {
    super(message ?? "Assertion failed");
    this.name = "AssertionError";
  }
}

export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message);
  }
}

export default assert;
