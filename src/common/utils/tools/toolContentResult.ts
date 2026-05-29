export interface ToolContentResult {
  type: "content";
  value: unknown[];
}

export function isToolContentResult(result: unknown): result is ToolContentResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { type?: unknown }).type === "content" &&
    Array.isArray((result as { value?: unknown }).value)
  );
}
