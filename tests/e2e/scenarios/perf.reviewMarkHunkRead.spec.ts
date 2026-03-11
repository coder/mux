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
const LARGE_DIFF_FILE_PATH = "src/review/perf-large-diff.ts";
const LARGE_DIFF_BLOCK_COUNT = 120;

interface LargeReviewDiffSummary {
  kind: "immersive-review-mark-read";
  filePath: string;
  blockCount: number;
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

function buildLargeReviewFixtureSource(blockCount: number, variant: "base" | "modified"): string {
  const marker = variant === "base" ? "pending" : "ready";
  const lines = [
    "export interface PerfReviewSection {",
    "  id: number;",
    "  summary: string;",
    "  checksum: number;",
    "}",
    "",
  ];

  for (let index = 0; index < blockCount; index += 1) {
    const blockId = String(index + 1).padStart(3, "0");
    lines.push(`export function buildPerfSection${blockId}(): PerfReviewSection {`);
    lines.push(`  const id = ${index + 1};`);
    lines.push(`  const checksum = ${5000 + index};`);
    lines.push(`  const title = "Section ${blockId}";`);
    lines.push("  const payload = [");
    lines.push(`    "alpha-${blockId}",`);
    lines.push(`    "beta-${blockId}",`);
    lines.push(`    "gamma-${blockId}",`);
    lines.push(`    "delta-${blockId}",`);
    lines.push('  ].join(":");');
    lines.push(`  const summary = \`${"${title}"}:${marker}:${"${payload}"}\`;`);
    lines.push("  return { id, summary, checksum };");
    lines.push("}");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function seedLargeReviewDiff(workspacePath: string): LargeReviewDiffSummary {
  const filePath = path.join(workspacePath, ...LARGE_DIFF_FILE_PATH.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.writeFileSync(
    filePath,
    buildLargeReviewFixtureSource(LARGE_DIFF_BLOCK_COUNT, "base"),
    "utf-8"
  );
  runGitCommand(workspacePath, ["add", LARGE_DIFF_FILE_PATH]);
  runGitCommand(workspacePath, ["commit", "-q", "-m", "Seed immersive review perf fixture"]);

  fs.writeFileSync(
    filePath,
    buildLargeReviewFixtureSource(LARGE_DIFF_BLOCK_COUNT, "modified"),
    "utf-8"
  );

  const diffOutput = runGitCommand(workspacePath, ["diff", "HEAD", "--", LARGE_DIFF_FILE_PATH]);
  const hunkCount = (diffOutput.match(/^@@/gm) ?? []).length;
  if (hunkCount !== LARGE_DIFF_BLOCK_COUNT) {
    throw new Error(
      `Expected ${LARGE_DIFF_BLOCK_COUNT} hunks in seeded diff, received ${hunkCount}`
    );
  }

  const numstatOutput = runGitCommand(workspacePath, [
    "diff",
    "HEAD",
    "--numstat",
    "--",
    LARGE_DIFF_FILE_PATH,
  ]).trim();
  const [addedText = "0", deletedText = "0"] = numstatOutput.split("\t");

  return {
    kind: "immersive-review-mark-read",
    filePath: LARGE_DIFF_FILE_PATH,
    blockCount: LARGE_DIFF_BLOCK_COUNT,
    hunkCount,
    addedLines: Number.parseInt(addedText, 10) || 0,
    deletedLines: Number.parseInt(deletedText, 10) || 0,
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

    const runLabel = `review-immersive-mark-read-${diffSummary.hunkCount}-hunks`;
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

    expect(chromeProfile.wallTimeMs).toBeGreaterThan(0);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
