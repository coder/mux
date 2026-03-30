import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const STORY_DIR = "src/browser/stories";
const MAX_SNAPSHOT_ENABLED_FILES = 9;
const MAX_ESTIMATED_SNAPSHOTS = 130;
const STORY_EXPORT_PATTERN = /^export const \w+/gm;
const SMOKE_MODE_PATTERN = /modes:\s*CHROMATIC_SMOKE_MODES/g;

function hasMetaDisable(content: string): boolean {
  const [metaSection = content] = content.split(/^export const \w+/m, 1);
  return (
    metaSection.includes("chromatic: CHROMATIC_DISABLED") ||
    /disableSnapshot:\s*true/.test(metaSection)
  );
}

describe("Storybook snapshot budget", () => {
  const storyFiles = readdirSync(STORY_DIR)
    .filter((f: string) => f.endsWith(".stories.tsx"))
    .map((f: string) => `${STORY_DIR}/${f}`);

  test(`app-level story files with snapshots enabled ≤ ${MAX_SNAPSHOT_ENABLED_FILES}`, () => {
    const filesWithSnapshots = storyFiles.filter((file: string) => {
      const content = readFileSync(file, "utf-8");
      return !hasMetaDisable(content);
    });

    expect(filesWithSnapshots.length).toBeLessThanOrEqual(MAX_SNAPSHOT_ENABLED_FILES);
  });

  test(`estimated total snapshots ≤ ${MAX_ESTIMATED_SNAPSHOTS}`, () => {
    let totalSnapshots = 0;

    for (const file of storyFiles) {
      const content = readFileSync(file, "utf-8");
      if (hasMetaDisable(content)) {
        continue;
      }

      const storyCount = (content.match(STORY_EXPORT_PATTERN) ?? []).length;
      if (storyCount === 0) {
        continue;
      }

      const smokeStories = (content.match(SMOKE_MODE_PATTERN) ?? []).length;
      totalSnapshots += storyCount + smokeStories;
    }

    expect(totalSnapshots).toBeLessThanOrEqual(MAX_ESTIMATED_SNAPSHOTS);
  });
});
