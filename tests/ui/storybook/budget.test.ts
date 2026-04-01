import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STORY_DIR = "src/browser/stories";
const COLOCATED_STORY_DIRS = ["src/browser/components", "src/browser/features"];
const MAX_SNAPSHOT_ENABLED_FILES = 70;
const MAX_ESTIMATED_SNAPSHOTS = 300;
const STORY_EXPORT_PATTERN = /^export const \w+/gm;
const SMOKE_MODE_PATTERN = /modes:\s*CHROMATIC_SMOKE_MODES/g;
const INLINE_MODE_OBJECT_PATTERN = /modes:\s*{/g;

function findColocatedStories(dirs: string[]): string[] {
  return dirs.flatMap((dir: string) =>
    (readdirSync(dir, { recursive: true }) as string[])
      .map((entry) => join(dir, entry))
      .filter((file: string) => file.endsWith(".stories.tsx"))
  );
}

function hasMetaDisable(content: string): boolean {
  const [metaSection = content] = content.split(/^export const \w+/m, 1);
  return (
    metaSection.includes("chromatic: CHROMATIC_DISABLED") ||
    /disableSnapshot:\s*true/.test(metaSection)
  );
}

function findClosingBrace(content: string, openingBraceIndex: number): number {
  let depth = 0;
  for (let index = openingBraceIndex; index < content.length; index += 1) {
    const char = content[index];
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function countTopLevelObjectEntries(objectLiteral: string): number {
  const source = objectLiteral.slice(1, -1);
  if (source.trim().length === 0) {
    return 0;
  }

  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let entryHasContent = false;
  let entryCount = 0;

  for (const char of source) {
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      entryHasContent = true;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      entryHasContent = true;
      continue;
    }
    if (char === "}") {
      braceDepth -= 1;
      entryHasContent = true;
      continue;
    }
    if (char === "[") {
      bracketDepth += 1;
      entryHasContent = true;
      continue;
    }
    if (char === "]") {
      bracketDepth -= 1;
      entryHasContent = true;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      entryHasContent = true;
      continue;
    }
    if (char === ")") {
      parenDepth -= 1;
      entryHasContent = true;
      continue;
    }

    const atTopLevel = braceDepth === 0 && bracketDepth === 0 && parenDepth === 0;
    if (char === "," && atTopLevel) {
      if (entryHasContent) {
        entryCount += 1;
        entryHasContent = false;
      }
      continue;
    }

    if (!/\s/.test(char)) {
      entryHasContent = true;
    }
  }

  if (entryHasContent) {
    entryCount += 1;
  }

  return entryCount;
}

function estimateInlineModeExtras(content: string): number {
  let extraSnapshots = 0;

  for (const match of content.matchAll(INLINE_MODE_OBJECT_PATTERN)) {
    if (match.index == null) {
      continue;
    }

    const openingBraceIndex = match.index + match[0].length - 1;
    const closingBraceIndex = findClosingBrace(content, openingBraceIndex);
    if (closingBraceIndex === -1) {
      continue;
    }

    const modeCount = countTopLevelObjectEntries(
      content.slice(openingBraceIndex, closingBraceIndex + 1)
    );
    extraSnapshots += Math.max(0, modeCount - 1);
  }

  return extraSnapshots;
}

describe("Storybook snapshot budget", () => {
  // Track snapshot budget across both legacy app-level stories and colocated stories.
  const appStoryFiles = readdirSync(STORY_DIR)
    .filter((f: string) => f.endsWith(".stories.tsx"))
    .map((f: string) => `${STORY_DIR}/${f}`);
  const colocatedStoryFiles = findColocatedStories(COLOCATED_STORY_DIRS);
  const allStoryFiles = [...appStoryFiles, ...colocatedStoryFiles];

  test(`story files with snapshots enabled ≤ ${MAX_SNAPSHOT_ENABLED_FILES}`, () => {
    const filesWithSnapshots = allStoryFiles.filter((file: string) => {
      const content = readFileSync(file, "utf-8");
      return !hasMetaDisable(content);
    });

    expect(filesWithSnapshots.length).toBeLessThanOrEqual(MAX_SNAPSHOT_ENABLED_FILES);
  });

  test(`estimated total snapshots ≤ ${MAX_ESTIMATED_SNAPSHOTS}`, () => {
    let totalSnapshots = 0;

    for (const file of allStoryFiles) {
      const content = readFileSync(file, "utf-8");
      if (hasMetaDisable(content)) {
        continue;
      }

      const storyCount = (content.match(STORY_EXPORT_PATTERN) ?? []).length;
      if (storyCount === 0) {
        continue;
      }

      const smokeStories = (content.match(SMOKE_MODE_PATTERN) ?? []).length;
      const inlineModeExtras = estimateInlineModeExtras(content);
      totalSnapshots += storyCount + smokeStories + inlineModeExtras;
    }

    expect(totalSnapshots).toBeLessThanOrEqual(MAX_ESTIMATED_SNAPSHOTS);
  });
});
