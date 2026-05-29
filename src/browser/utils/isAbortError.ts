export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === "AbortError";
  }

  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name === "AbortError";
}
