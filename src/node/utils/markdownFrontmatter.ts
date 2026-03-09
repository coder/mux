/**
 * Shared utilities for parsing YAML-frontmatter markdown files (SKILL.md, AGENT.md, etc.).
 * Extracted from parseAgentDefinitionMarkdown.ts and parseSkillMarkdown.ts to deduplicate.
 */

/** Normalize \r\n and \r line endings to \n. */
export function normalizeNewlines(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Strip the UTF-8 BOM (U+FEFF) if present at the start of the string. */
export function stripUtf8Bom(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

/** Format Zod validation issues into a semicolon-delimited summary string. */
export function formatZodIssues(
  issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }>
): string {
  return issues
    .map((issue) => {
      const issuePath =
        issue.path.length > 0 ? issue.path.map((part) => String(part)).join(".") : "<root>";
      return `${issuePath}: ${issue.message}`;
    })
    .join("; ");
}
