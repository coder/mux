import { type Page } from "@playwright/test";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { REVIEW_SORT_ORDER_KEY, TUTORIAL_STATE_KEY } from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";
import { seedLargeReviewDiff } from "../utils/reviewPerfFixture";

const shouldRunPerfScenarios = process.env.MUX_E2E_RUN_PERF === "1";

async function disableReviewTutorial(page: Page): Promise<void> {
  await page.evaluate((tutorialStateKey) => {
    const raw = window.localStorage.getItem(tutorialStateKey);
    const parsed = raw
      ? (JSON.parse(raw) as { disabled?: boolean; completed?: Record<string, boolean> })
      : null;
    window.localStorage.setItem(
      tutorialStateKey,
      JSON.stringify({
        disabled: parsed?.disabled ?? false,
        completed: {
          ...(parsed?.completed ?? {}),
          review: true,
        },
      })
    );
  }, TUTORIAL_STATE_KEY);

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
}

async function waitForRegularReviewReady(page: Page, hunkCount: number): Promise<void> {
  const reviewPanel = page.getByTestId("review-panel");
  await expect(reviewPanel).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("review-file-tree")).toBeVisible({ timeout: 20_000 });
  await expect(reviewPanel.getByText(`0/${hunkCount}`, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("[data-hunk-id]").first()).toBeVisible({ timeout: 20_000 });
}

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("regular review performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set MUX_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: reopen regular review for a large diff", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    await disableReviewTutorial(page);

    const diffSummary = seedLargeReviewDiff(workspace.demoProject.workspacePath);
    const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspace.demoProject.workspaceId);

    // Pin Review to HEAD before the panel mounts so the warm-cache reopen profiles
    // the regular-review render path rather than origin/main fallback handling.
    await page.evaluate(
      ({ diffBaseKey, sortOrderKey }) => {
        window.localStorage.setItem(diffBaseKey, JSON.stringify("HEAD"));
        window.localStorage.setItem("review-show-read", JSON.stringify(true));
        window.localStorage.setItem(sortOrderKey, JSON.stringify("file-order"));
      },
      {
        diffBaseKey: reviewDiffBaseKey,
        sortOrderKey: REVIEW_SORT_ORDER_KEY,
      }
    );

    await ui.projects.openFirstWorkspace();
    await ui.metaSidebar.expectVisible();

    await ui.metaSidebar.selectTab("Review");
    await waitForRegularReviewReady(page, diffSummary.hunkCount);

    await ui.metaSidebar.selectTab("Stats");
    await expect(page.getByTestId("review-panel")).not.toBeVisible({ timeout: 20_000 });

    await resetReactProfileSamples(page);

    const runLabel = `review-regular-reopen-${diffSummary.fileCount}-files-${diffSummary.hunkCount}-hunks`;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await ui.metaSidebar.selectTab("Review");
      await waitForRegularReviewReady(page, diffSummary.hunkCount);
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) {
      throw new Error("React profile snapshot was not captured");
    }

    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: {
        kind: "regular-review-reopen",
        ...diffSummary,
      },
    });

    expect(chromeProfile.wallTimeMs).toBeLessThan(3_500);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
