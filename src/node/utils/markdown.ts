/**
 * Simple markdown frontmatter parsing utilities.
 *
 * For more complex/validated frontmatter parsing (e.g., SKILL.md),
 * see src/node/services/agentSkills/parseSkillMarkdown.ts
 */

import YAML from "yaml";

export interface SimpleFrontmatter {
  description?: string;
  [key: string]: unknown;
}

/**
 * Parse optional YAML frontmatter from markdown content.
 * Returns the parsed frontmatter (if valid) and the body (content after frontmatter).
 *
 * Unlike parseSkillMarkdown, this is lenient:
 * - Frontmatter is optional (missing = empty object)
 * - Invalid YAML is silently ignored (treated as no frontmatter)
 * - No schema validation (accepts any keys)
 */
export function parseSimpleFrontmatter(content: string): {
  frontmatter: SimpleFrontmatter;
  body: string;
} {
  // Normalize newlines
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Check for frontmatter delimiter at start
  if (!normalized.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    return { frontmatter: {}, body: content };
  }

  // Find closing delimiter
  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) {
    return { frontmatter: {}, body: content };
  }

  const yamlText = lines.slice(1, endIndex).join("\n");
  const body = lines.slice(endIndex + 1).join("\n");

  try {
    const parsed: unknown = YAML.parse(yamlText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as SimpleFrontmatter, body };
    }
  } catch {
    // Invalid YAML, treat as no frontmatter
  }

  return { frontmatter: {}, body };
}
