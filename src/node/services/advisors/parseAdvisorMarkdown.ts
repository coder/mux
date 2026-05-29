import YAML from "yaml";

import { AdvisorFrontmatterSchema } from "@/common/orpc/schemas";
import type { AdvisorFrontmatter, AdvisorName } from "@/common/types/advisor";
import { getErrorMessage } from "@/common/utils/errors";
import { MAX_FILE_SIZE } from "@/node/services/tools/fileCommon";
import { formatZodIssues, normalizeNewlines, stripUtf8Bom } from "@/node/utils/markdownFrontmatter";

/**
 * Parse a `.mux/advisors/<name>/ADVISOR.md` file into validated frontmatter
 * plus prompt-suffix body.
 *
 * Mirrors {@link parseSkillMarkdown} so users have a single mental model for
 * configuration-as-code surfaces. The advisor name comes from the directory,
 * not the frontmatter — keeping the file body free of redundant identity
 * fields that drift out of sync with the filesystem.
 */
export class AdvisorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdvisorParseError";
  }
}

export interface ParsedAdvisorMarkdown {
  frontmatter: AdvisorFrontmatter;
  body: string;
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdvisorParseError(message);
  }
}

export function parseAdvisorMarkdown(input: {
  content: string;
  byteSize: number;
  directoryName?: AdvisorName;
}): ParsedAdvisorMarkdown {
  if (input.byteSize > MAX_FILE_SIZE) {
    const sizeMB = (input.byteSize / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(2);
    throw new AdvisorParseError(
      `ADVISOR.md is too large (${sizeMB}MB). Maximum supported size is ${maxMB}MB.`
    );
  }

  const content = normalizeNewlines(stripUtf8Bom(input.content));

  if (!content.startsWith("---")) {
    throw new AdvisorParseError("ADVISOR.md must start with YAML frontmatter delimited by '---'.");
  }

  const lines = content.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    throw new AdvisorParseError("ADVISOR.md frontmatter start delimiter must be exactly '---'.");
  }

  const endIndex = lines.findIndex((line, idx) => idx > 0 && line.trim() === "---");
  if (endIndex === -1) {
    throw new AdvisorParseError("ADVISOR.md frontmatter is missing the closing '---' delimiter.");
  }

  const yamlText = lines.slice(1, endIndex).join("\n");
  // Keep the body verbatim (including trailing newlines) so a user-authored
  // prompt suffix renders predictably when appended to ADVISOR_SYSTEM_PROMPT.
  const body = lines.slice(endIndex + 1).join("\n");

  let raw: unknown;
  try {
    raw = YAML.parse(yamlText);
  } catch (err) {
    throw new AdvisorParseError(
      `Failed to parse ADVISOR.md YAML frontmatter: ${getErrorMessage(err)}`
    );
  }

  assertObject(raw, "ADVISOR.md YAML frontmatter must be a mapping/object.");

  const parsed = AdvisorFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdvisorParseError(
      `Invalid ADVISOR.md frontmatter: ${formatZodIssues(parsed.error.issues)}`
    );
  }

  // Directory name is the canonical identity. We accept (and ignore) callers
  // that don't pass it (e.g., a one-off `parseAdvisorMarkdown` from a CLI
  // pipeline), but when present, the body cannot contradict the filesystem.
  if (input.directoryName?.length === 0) {
    throw new AdvisorParseError("ADVISOR directory name must be non-empty when provided.");
  }

  return { frontmatter: parsed.data, body };
}
