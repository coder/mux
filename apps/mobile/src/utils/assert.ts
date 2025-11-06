export function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) {
    const error = new Error(message ?? "Assertion failed");
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console -- helpful during development to surface assertion context
      console.error(error);
    }
    throw error;
  }
}
