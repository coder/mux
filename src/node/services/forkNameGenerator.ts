/**
 * Generate incremented names and titles for forked workspaces.
 *
 * Given a workspace with title "Fixing bugs" and name "bugs-asd23",
 * forking produces:
 *   Fork 1: title "Fixing bugs 2", name "bugs-asd23-2"
 *   Fork 2: title "Fixing bugs 3", name "bugs-asd23-3"
 */

/**
 * Extract the base name and current suffix from a workspace name.
 * Returns { base, suffix } where suffix is the numeric fork count (0 if not a fork).
 *
 * Examples:
 *   "bugs-asd23" -> { base: "bugs-asd23", suffix: 0 }
 *   "bugs-asd23-2" -> { base: "bugs-asd23", suffix: 2 }
 *   "bugs-asd23-10" -> { base: "bugs-asd23", suffix: 10 }
 */
export function parseWorkspaceName(name: string): { base: string; suffix: number } {
  const match = /^(.+)-(\d+)$/.exec(name);
  if (match) {
    const [, base, numStr] = match;
    const num = parseInt(numStr, 10);
    // Only treat as fork suffix if it's >= 2 (fork numbering starts at 2)
    if (num >= 2) {
      return { base, suffix: num };
    }
  }
  return { base: name, suffix: 0 };
}

/**
 * Extract the base title and current suffix from a workspace title.
 * Returns { base, suffix } where suffix is the numeric fork count (0 if not a fork).
 *
 * Examples:
 *   "Fixing bugs" -> { base: "Fixing bugs", suffix: 0 }
 *   "Fixing bugs 2" -> { base: "Fixing bugs", suffix: 2 }
 *   "Fixing bugs 10" -> { base: "Fixing bugs", suffix: 10 }
 */
export function parseWorkspaceTitle(title: string): { base: string; suffix: number } {
  const match = /^(.+)\s+(\d+)$/.exec(title);
  if (match) {
    const [, base, numStr] = match;
    const num = parseInt(numStr, 10);
    // Only treat as fork suffix if it's >= 2 (fork numbering starts at 2)
    if (num >= 2) {
      return { base, suffix: num };
    }
  }
  return { base: title, suffix: 0 };
}

/**
 * Generate the next fork name by incrementing the suffix.
 *
 * Examples:
 *   "bugs-asd23" -> "bugs-asd23-2"
 *   "bugs-asd23-2" -> "bugs-asd23-3"
 */
export function generateForkName(sourceName: string): string {
  const { base, suffix } = parseWorkspaceName(sourceName);
  const nextSuffix = suffix === 0 ? 2 : suffix + 1;
  return `${base}-${nextSuffix}`;
}

/**
 * Generate the next fork title by incrementing the suffix.
 *
 * Examples:
 *   "Fixing bugs" -> "Fixing bugs 2"
 *   "Fixing bugs 2" -> "Fixing bugs 3"
 */
export function generateForkTitle(sourceTitle: string): string {
  const { base, suffix } = parseWorkspaceTitle(sourceTitle);
  const nextSuffix = suffix === 0 ? 2 : suffix + 1;
  return `${base} ${nextSuffix}`;
}

/**
 * Generate both name and title for a forked workspace.
 */
export function generateForkIdentity(
  sourceName: string,
  sourceTitle: string | undefined
): { name: string; title: string | undefined } {
  return {
    name: generateForkName(sourceName),
    title: sourceTitle ? generateForkTitle(sourceTitle) : undefined,
  };
}
