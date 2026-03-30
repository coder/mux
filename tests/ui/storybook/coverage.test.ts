import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const STORY_DIR = "src/browser/stories";

/** App-level integration allowlist — files that must exist with smoke coverage. */
const REQUIRED_APP_STORIES = [
  "App.sidebar.stories.tsx",
  "App.welcome.stories.tsx",
  "App.landingPage.stories.tsx",
  "App.commandPalette.stories.tsx",
  "App.errors.stories.tsx",
  "App.titlebar.stories.tsx",
  "App.phoneViewports.stories.tsx",
  "App.projectCreate.stories.tsx",
] as const;

describe("Storybook coverage contract", () => {
  for (const filename of REQUIRED_APP_STORIES) {
    const filepath = `${STORY_DIR}/${filename}`;

    test(`${filename} exists`, () => {
      expect(existsSync(filepath)).toBe(true);
    });

    test(`${filename} has explicit chromatic mode policy`, () => {
      const content = readFileSync(filepath, "utf-8");
      // Must use one of the shared mode constants (not bare inline modes)
      const usesSharedPolicy =
        content.includes("CHROMATIC_SMOKE_MODES") ||
        content.includes("CHROMATIC_SINGLE_MODE") ||
        content.includes("CHROMATIC_DISABLED");
      expect(usesSharedPolicy).toBe(true);
    });

    test(`${filename} has at least one smoke story with dual-theme coverage`, () => {
      const content = readFileSync(filepath, "utf-8");
      // Must appear in a modes assignment context, not just as an import
      const hasSmokeModeUsage =
        /modes:\s*CHROMATIC_SMOKE_MODES/.test(content) ||
        /modes:\s*\{[^}]*CHROMATIC_SMOKE_MODES/.test(content);
      expect(hasSmokeModeUsage).toBe(true);
    });
  }
});
