export function normalizeMarkdown(content: string): string {
  return content.replace(/\n{3,}/g, "\n\n");
}

export function hasRenderableMarkdown(content: string | null | undefined): boolean {
  if (typeof content !== "string") {
    return false;
  }

  return content.trim().length > 0;
}
