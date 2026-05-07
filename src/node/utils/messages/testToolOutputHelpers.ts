export function expectContentOutputValue(output: unknown): unknown[] {
  if (
    typeof output === "object" &&
    output !== null &&
    (output as { type?: unknown }).type === "content" &&
    Array.isArray((output as { value?: unknown }).value)
  ) {
    return (output as { value: unknown[] }).value;
  }

  throw new Error("Expected rewritten content output");
}
