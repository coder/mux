// Shared helper for generating bash task display names.
//
// Background process IDs are derived from display names and used as directory names.
// When display_name is omitted, we derive a short, filesystem-safe name from the script.

const DEFAULT_BASH_DISPLAY_NAME = "bash";
const MAX_BASH_DISPLAY_NAME_CHARS = 80;

const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;
const TRAILING_DOTS_OR_SPACES = /[. ]+$/g;

function sanitizeBashDisplayName(rawName: string): string {
  // Collapse whitespace to keep IDs readable and stable.
  let name = rawName.replace(/\s+/g, " ").trim();

  if (name.length === 0) return DEFAULT_BASH_DISPLAY_NAME;

  // Bound the length before filename sanitization to avoid excessively-long paths.
  if (name.length > MAX_BASH_DISPLAY_NAME_CHARS) {
    name = name.slice(0, MAX_BASH_DISPLAY_NAME_CHARS);
  }

  // Replace ASCII control characters (0x00-0x1F) to avoid invalid filenames.
  let controlCharsStripped = "";
  for (const char of name) {
    const code = char.codePointAt(0);
    controlCharsStripped += code !== undefined && code < 0x20 ? "_" : char;
  }
  name = controlCharsStripped;

  // Replace characters that are illegal in Windows filenames (and also problematic on Unix).
  // This includes path separators, preventing path traversal via display_name.
  name = name.replace(INVALID_FILENAME_CHARS, "_");
  // Windows disallows trailing dots/spaces in file/dir names.
  name = name.replace(TRAILING_DOTS_OR_SPACES, "").trim();

  if (name.length === 0 || name === "." || name === "..") return DEFAULT_BASH_DISPLAY_NAME;

  return name;
}

export function getDefaultBashDisplayName(script: string): string {
  const firstNonEmptyLine =
    script
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  return sanitizeBashDisplayName(firstNonEmptyLine);
}

export function resolveBashDisplayName(script: string, displayName: string | undefined): string {
  const trimmed = displayName?.trim();
  if (trimmed && trimmed.length > 0) {
    return sanitizeBashDisplayName(trimmed);
  }

  return getDefaultBashDisplayName(script);
}
