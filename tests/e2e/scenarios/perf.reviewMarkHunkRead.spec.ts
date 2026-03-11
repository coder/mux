import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { electronTest as test, electronExpect as expect } from "../electronTest";
import { REVIEW_SORT_ORDER_KEY, getReviewStateKey } from "../../../src/common/constants/storage";
import { STORAGE_KEYS } from "../../../src/constants/workspaceDefaults";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";

const shouldRunPerfScenarios = process.env.MUX_E2E_RUN_PERF === "1";
const LARGE_CHANGE_ROOT = "src/review/perf-large-change";
// Keep this fixture deliberately large so immersive mark-read profiling exercises the
// hidden sidebar + file tree work that shows up on branch-sized diffs.
const LARGE_CHANGE_GROUP_COUNT = 20;
const LARGE_CHANGE_BUCKETS_PER_GROUP = 10;
const LARGE_CHANGE_FILES_PER_BUCKET = 5;
const LARGE_CHANGE_FILE_COUNT =
  LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP * LARGE_CHANGE_FILES_PER_BUCKET;

interface LargeReviewDiffSummary {
  kind: "immersive-review-mark-read";
  rootPath: string;
  fileCount: number;
  directoryCount: number;
  hunkCount: number;
  addedLines: number;
  deletedLines: number;
}

function runGitCommand(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status === 0) {
    return result.stdout;
  }

  const stderr = result.stderr.trim();
  throw new Error(
    `git ${args.join(" ")} failed in ${cwd}: ${stderr || `exit ${result.status ?? "unknown"}`}`
  );
}

function buildLargeReviewFixtureSource(fileIndex: number, variant: "base" | "modified"): string {
  const fileId = String(fileIndex + 1).padStart(3, "0");
  const status = variant === "base" ? "pending" : "ready";

  return [
    `export const reviewProbe${fileId} = {`,
    `  id: ${fileIndex + 1},`,
    `  status: "${status}",`,
    `  checksum: ${5_000 + fileIndex},`,
    `  summary: "Perf review probe ${fileId}",`,
    "};",
    "",
  ].join("\n");
}

function seedLargeReviewDiff(workspacePath: string): LargeReviewDiffSummary {
  const filePaths: string[] = [];
  let fileIndex = 0;

  for (let groupIndex = 0; groupIndex < LARGE_CHANGE_GROUP_COUNT; groupIndex += 1) {
    const groupId = String(groupIndex + 1).padStart(2, "0");
    for (let bucketIndex = 0; bucketIndex < LARGE_CHANGE_BUCKETS_PER_GROUP; bucketIndex += 1) {
      const bucketId = String(bucketIndex + 1).padStart(2, "0");
      for (
        let bucketFileIndex = 0;
        bucketFileIndex < LARGE_CHANGE_FILES_PER_BUCKET;
        bucketFileIndex += 1
      ) {
        const relativePath = [
          LARGE_CHANGE_ROOT,
          `group-${groupId}`,
          `bucket-${bucketId}`,
          `probe-${String(fileIndex + 1).padStart(3, "0")}.ts`,
        ].join("/");
        const filePath = path.join(workspacePath, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buildLargeReviewFixtureSource(fileIndex, "base"), "utf-8");
        filePaths.push(relativePath);
        fileIndex += 1;
      }
    }
  }

  if (filePaths.length !== LARGE_CHANGE_FILE_COUNT) {
    throw new Error(
      `Expected ${LARGE_CHANGE_FILE_COUNT} generated files, received ${filePaths.length}`
    );
  }

  runGitCommand(workspacePath, ["add", LARGE_CHANGE_ROOT]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed immersive review perf fixture"]);

  for (const [index, relativePath] of filePaths.entries()) {
    const filePath = path.join(workspacePath, ...relativePath.split("/"));
    fs.writeFileSync(filePath, buildLargeReviewFixtureSource(index, "modified"), "utf-8");
  }

  const diffOutput = runGitCommand(workspacePath, ["diff", "HEAD"]);
  const hunkCount = (diffOutput.match(/^@@/gm) ?? []).length;
  if (hunkCount !== filePaths.length) {
    throw new Error(`Expected ${filePaths.length} hunks in seeded diff, received ${hunkCount}`);
  }

  let addedLines = 0;
  let deletedLines = 0;
  const numstatOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--numstat"]).trim();
  for (const line of numstatOutput.split("\n").filter(Boolean)) {
    const [addedText = "0", deletedText = "0"] = line.split("\t");
    addedLines += Number.parseInt(addedText, 10) || 0;
    deletedLines += Number.parseInt(deletedText, 10) || 0;
  }

  return {
    kind: "immersive-review-mark-read",
    rootPath: LARGE_CHANGE_ROOT,
    fileCount: filePaths.length,
    directoryCount:
      2 + LARGE_CHANGE_GROUP_COUNT + LARGE_CHANGE_GROUP_COUNT * LARGE_CHANGE_BUCKETS_PER_GROUP,
    hunkCount,
    addedLines,
    deletedLines,
  };
}

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("immersive review performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set MUX_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: mark hunk as read in immersive review for a large diff", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    const diffSummary = seedLargeReviewDiff(workspace.demoProject.workspacePath);
    const reviewDiffBaseKey = STORAGE_KEYS.reviewDiffBase(workspace.demoProject.workspaceId);
    const reviewStateKey = getReviewStateKey(workspace.demoProject.workspaceId);

    // The demo repo has no origin/main, so the perf scenario pins Review to HEAD before
    // the panel mounts. That keeps the scenario focused on a real local git diff.
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

    const reviewPanel = page.getByTestId("review-panel");
    await expect(reviewPanel).toBeVisible();
    await expect(reviewPanel.getByText(`0/${diffSummary.hunkCount}`, { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    const immersiveButton = reviewPanel.getByRole("button", { name: "Enter immersive review" });
    await expect(immersiveButton).toBeVisible();
    // Dispatch directly so the review tutorial backdrop cannot intercept the perf interaction.
    await immersiveButton.dispatchEvent("click");

    const immersiveReview = page.getByTestId("immersive-review-view");
    await expect(immersiveReview).toBeVisible({ timeout: 20_000 });

    const markReadButton = immersiveReview.getByRole("button", { name: "Mark hunk as read" });
    await expect(markReadButton).toBeVisible({ timeout: 20_000 });

    await resetReactProfileSamples(page);

    const runLabel = `review-immersive-mark-read-${diffSummary.fileCount}-files-${diffSummary.hunkCount}-hunks`;
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await markReadButton.dispatchEvent("click");
      await expect(
        immersiveReview.getByRole("button", { name: "Mark hunk as unread" })
      ).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(
          () =>
            page.evaluate((key) => {
              const raw = window.localStorage.getItem(key);
              if (!raw) {
                return 0;
              }
              const parsed = JSON.parse(raw) as {
                readState?: Record<string, { isRead?: boolean }>;
              };
              return Object.values(parsed.readState ?? {}).filter((entry) => entry.isRead).length;
            }, reviewStateKey),
          { timeout: 20_000 }
        )
        .toBe(1);
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
      historyProfile: diffSummary,
    });

    expect(chromeProfile.wallTimeMs).toBeLessThan(1_000);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
