import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const STORY_DIR = "src/browser/stories";
const PLAN_TOC_STORY_PATH =
  "src/browser/features/Tools/ProposePlan/ProposePlanToolCall.stories.tsx";
const PLAN_TOC_MIN_CHROMATIC_WIDTH = 1600;

/** App-level integration allowlist — files that must exist with smoke coverage. */
const REQUIRED_APP_STORIES = [
  "App.commandPalette.stories.tsx",
  "App.phoneViewports.stories.tsx",
] as const;

const REQUIRED_COLOCATED_STORIES = [
  "src/browser/components/ProjectCreateModal/ProjectCreateModal.stories.tsx",
  "src/browser/components/TitleBar/TitleBar.stories.tsx",
  "src/browser/components/WorkspaceMenuBar/WorkspaceMenuBar.stories.tsx",
  "src/browser/components/ProjectPage/ProjectPage.stories.tsx",
  "src/browser/features/Messages/ChatBarrier/InterruptedBarrier.stories.tsx",
  "src/browser/components/DebugLlmRequestModal/DebugLlmRequestModal.stories.tsx",
  "src/browser/components/AIView/AIView.stories.tsx",
  "src/browser/components/ProjectSidebar/ProjectSidebar.stories.tsx",
  "src/browser/features/Messages/MessageRenderer.stories.tsx",
] as const;

const MIGRATED_APP_STORIES = [
  "App.sidebar.stories.tsx",
  "App.welcome.stories.tsx",
  "App.errors.stories.tsx",
  "App.titlebar.stories.tsx",
  "App.projectCreate.stories.tsx",
] as const;

const hasExplicitChromaticModePolicy = (content: string): boolean => {
  // Must use one of the shared mode constants (not bare inline modes)
  return (
    content.includes("CHROMATIC_SMOKE_MODES") ||
    content.includes("CHROMATIC_SINGLE_MODE") ||
    content.includes("CHROMATIC_DISABLED")
  );
};

const hasSmokeStoryWithDualThemeCoverage = (content: string): boolean => {
  // Must appear in a modes assignment context, not just as an import
  return (
    /modes:\s*CHROMATIC_SMOKE_MODES/.test(content) ||
    /modes:\s*\{[^}]*CHROMATIC_SMOKE_MODES/.test(content)
  );
};

function getPlanTocChromaticWidth(content: string): number | null {
  const viewportMatch = content.match(
    /PLAN_TOC_CHROMATIC_VIEWPORT\s*=\s*\{\s*width:\s*(\d+),\s*height:\s*\d+\s*\}/
  );
  if (!viewportMatch?.[1]) {
    return null;
  }

  return Number(viewportMatch[1]);
}

function hasPlanTocWideChromaticMode(content: string): boolean {
  return (
    /PLAN_TOC_CHROMATIC_MODES\s*=\s*\{[\s\S]*viewport:\s*PLAN_TOC_CHROMATIC_VIEWPORT/.test(
      content
    ) && /modes:\s*PLAN_TOC_CHROMATIC_MODES/.test(content)
  );
}

describe("Storybook coverage contract", () => {
  describe("App stories", () => {
    for (const filename of REQUIRED_APP_STORIES) {
      const filepath = `${STORY_DIR}/${filename}`;

      test(`${filename} exists`, () => {
        expect(existsSync(filepath)).toBe(true);
      });

      test(`${filename} has explicit chromatic mode policy`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasExplicitChromaticModePolicy(content)).toBe(true);
      });

      test(`${filename} has at least one smoke story with dual-theme coverage`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasSmokeStoryWithDualThemeCoverage(content)).toBe(true);
      });
    }
  });

  describe("Colocated stories", () => {
    for (const filepath of REQUIRED_COLOCATED_STORIES) {
      test(`${filepath} exists`, () => {
        expect(existsSync(filepath)).toBe(true);
      });

      test(`${filepath} has explicit chromatic mode policy`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasExplicitChromaticModePolicy(content)).toBe(true);
      });

      test(`${filepath} has at least one smoke story with dual-theme coverage`, () => {
        const content = readFileSync(filepath, "utf-8");
        expect(hasSmokeStoryWithDualThemeCoverage(content)).toBe(true);
      });
    }
  });

  describe("Story-specific visual contracts", () => {
    test("plan ToC story pins a wide Chromatic viewport", () => {
      const content = readFileSync(PLAN_TOC_STORY_PATH, "utf-8");

      // This story validates gutter-only UI: the full ToC is hidden at Chromatic's
      // default 1200px width, so it must carry an explicit wide mode.
      expect(hasPlanTocWideChromaticMode(content)).toBe(true);
      expect(getPlanTocChromaticWidth(content)).toBeGreaterThanOrEqual(
        PLAN_TOC_MIN_CHROMATIC_WIDTH
      );
    });
  });

  describe("Migrated files removed", () => {
    for (const filename of MIGRATED_APP_STORIES) {
      test(`${filename} does not exist in src/browser/stories`, () => {
        expect(existsSync(`${STORY_DIR}/${filename}`)).toBe(false);
      });
    }
  });
});
