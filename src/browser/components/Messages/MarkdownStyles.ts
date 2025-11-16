// Normalize markdown to remove excess blank lines
export function normalizeMarkdown(content: string): string {
  // Replace 3 or more consecutive newlines with exactly 2 newlines
  return content.replace(/\n{3,}/g, "\n\n");
}
