#!/usr/bin/env bun
/**
 * Capture README screenshots from Storybook stories using Playwright + Sharp.
 *
 * Expects Storybook to be running already (default: http://localhost:6006).
 * Navigates to each story's iframe URL, waits for rendering, captures a PNG,
 * then converts to WebP (quality 90) via Sharp.
 *
 * Usage:
 *   bun run scripts/capture-readme-screenshots.ts
 *   bun run scripts/capture-readme-screenshots.ts --storybook-url http://localhost:6006
 *   bun run scripts/capture-readme-screenshots.ts --story CodeReview
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const { values: flags } = parseArgs({
  options: {
    "storybook-url": { type: "string", default: "http://localhost:6006" },
    story: { type: "string" },
  },
  strict: true,
});

const STORYBOOK_URL = flags["storybook-url"]!;
const SINGLE_STORY = flags.story;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIEWPORT = { width: 1900, height: 1188 };
const DEVICE_SCALE_FACTOR = 2;
const WEBP_QUALITY = 90;

/**
 * Target output width for documentation screenshots. We capture at 3800px
 * (1900 CSS × DPR 2) and keep the final README assets at that full width for
 * a consistent, high-fidelity result.
 */
const TARGET_WIDTH = 3800;

const DOCS_IMG_DIR = path.resolve(import.meta.dirname, "..", "docs", "img");

// Storybook title "Docs/README Screenshots" → id prefix "docs-readme-screenshots--"
const STORY_ID_PREFIX = "docs-readme-screenshots--";

/**
 * Story definitions. `playInteraction` is a Playwright callback that replicates
 * the Storybook play function for stories that require user interaction before
 * the screenshot is taken.
 */
interface StoryDef {
  exportName: string;
  storyId: string;
  outputFile: string;
  /** Optional crop region in CSS pixels for focused README screenshots. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Optional per-story viewport override (CSS pixels). Defaults to global VIEWPORT. */
  viewport?: { width: number; height: number };
  /** Replicate the Storybook play function via Playwright interactions. */
  playInteraction?: (page: Page) => Promise<void>;
  /** Custom Sharp post-processing instead of the default full-page → WebP conversion. */
  postProcess?: (pngBuffer: Buffer) => Promise<Buffer>;
}

const STORIES: StoryDef[] = [
  // README hero uses mux-demo.gif; screenshot captures start at code-review.webp.
  {
    exportName: "CodeReview",
    storyId: `${STORY_ID_PREFIX}code-review`,
    outputFile: "code-review.webp",
  },
  {
    exportName: "AgentStatusSidebar",
    storyId: `${STORY_ID_PREFIX}agent-status-sidebar`,
    outputFile: "agent-status.webp",
    clip: { x: 0, y: 0, width: 700, height: 900 },
  },
  {
    exportName: "GitStatusPopover",
    storyId: `${STORY_ID_PREFIX}git-status-popover`,
    outputFile: "git-status.webp",
    clip: { x: 0, y: 0, width: 750, height: 850 },
    playInteraction: async (page: Page) => {
      // Wait for git status to render in the ws-diverged row.
      const row = page.locator('[data-workspace-id="ws-diverged"]');
      const plusText = row.getByText("+12.3k");
      await plusText.waitFor({ timeout: 30_000 });

      // Hover to open tooltip.
      await plusText.hover();

      // Wait for the tooltip (portaled to body) to appear.
      const tooltip = page.locator('.bg-modal-bg[data-state="open"]');
      await tooltip.waitFor({ timeout: 10_000 });

      // Click "Commits" tab in the tooltip (use radio role to avoid ambiguity).
      await tooltip.getByRole("radio", { name: "Show commit divergence" }).click();

      // Wait for divergence indicators to appear.
      await row.getByText("↑3").waitFor({ timeout: 5_000 });
      await row.getByText("↓2").waitFor({ timeout: 5_000 });
    },
  },
  {
    exportName: "PlanMermaidWithCosts",
    storyId: `${STORY_ID_PREFIX}plan-mermaid-with-costs`,
    outputFile: "plan-mermaid.webp",
  },
  {
    exportName: "ProjectSecretsModal",
    storyId: `${STORY_ID_PREFIX}project-secrets-modal`,
    outputFile: "project-secrets.webp",
    clip: { x: 350, y: 50, width: 1200, height: 900 },
    playInteraction: async (page: Page) => {
      // The "Manage secrets" button is hidden until hover. Target the button directly
      // by its aria-label (which is unique) and force-click to bypass visibility.
      const manageBtn = page.getByRole("button", { name: "Manage secrets for mux" });
      await manageBtn.waitFor({ timeout: 30_000 });
      await manageBtn.click({ force: true });

      // Wait for the modal to appear with secrets content.
      // Secret keys are rendered inside <input> elements, so use getByDisplayValue.
      await page.getByText(/Manage Secrets/i).waitFor({ timeout: 10_000 });
      await page.locator('input[value="GITHUB_TOKEN"]').waitFor({ timeout: 5_000 });
    },
  },
  {
    exportName: "CostsTabRich",
    storyId: `${STORY_ID_PREFIX}costs-tab-rich`,
    outputFile: "costs-tab.webp",
    clip: { x: 1050, y: 0, width: 850, height: 1100 },
  },
  {
    exportName: "OpportunisticCompactionTooltip",
    storyId: `${STORY_ID_PREFIX}opportunistic-compaction-tooltip`,
    outputFile: "opportunistic-compaction.webp",
    clip: { x: 150, y: 350, width: 1000, height: 750 },
    playInteraction: async (page: Page) => {
      // Wait for costs to render.
      await page.getByText(/cache create/i).waitFor({ timeout: 15_000 });

      // Hover the last "Start Here" button to show the compaction tooltip.
      // Multiple assistant messages may have "Start Here"; we want the final one.
      const startHere = page.getByRole("button", { name: "Start Here" }).last();
      await startHere.hover();

      // Wait for the tooltip text to appear.
      await page
        .getByText("Replace all chat history with this message")
        .waitFor({ timeout: 10_000 });
    },
  },
  {
    exportName: "OrchestrateAgents",
    storyId: `${STORY_ID_PREFIX}orchestrate-agents`,
    outputFile: "orchestrate-agents.webp",
    // Narrower viewport makes the plan card + "Start Orchestrator" button more prominent
    viewport: { width: 1200, height: 1188 },
    clip: { x: 0, y: 0, width: 1200, height: 1000 },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function iframeUrl(storyId: string): string {
  return `${STORYBOOK_URL}/iframe.html?id=${storyId}&viewMode=story`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const storiesToCapture = SINGLE_STORY
    ? STORIES.filter((s) => s.exportName === SINGLE_STORY)
    : STORIES;

  if (storiesToCapture.length === 0) {
    console.error(
      `Unknown story "${SINGLE_STORY}". Valid names: ${STORIES.map((s) => s.exportName).join(", ")}`
    );
    process.exit(1);
  }

  // Verify Storybook is reachable.
  try {
    const resp = await fetch(STORYBOOK_URL, { signal: AbortSignal.timeout(5_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch {
    console.error(`Storybook is not running at ${STORYBOOK_URL}.`);
    console.error("Start it with: make storybook");
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    colorScheme: "dark",
  });

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const story of storiesToCapture) {
    const outputPath = path.join(DOCS_IMG_DIR, story.outputFile);
    const relPath = path.relative(process.cwd(), outputPath);

    // Stories with playInteraction can be flaky under sequential load (Radix
    // portals, hover timing). Retry up to MAX_RETRIES times before giving up.
    const MAX_RETRIES = 3;
    let captured = false;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (attempt === 1) {
        console.log(`Capturing ${story.exportName} → ${relPath}...`);
      } else {
        console.log(`  retry ${attempt}/${MAX_RETRIES}...`);
      }

      const page = await context.newPage();
      try {
        if (story.viewport) {
          await page.setViewportSize(story.viewport);
        }

        // Navigate and wait for network idle + DOM stability.
        await page.goto(iframeUrl(story.storyId), {
          waitUntil: "networkidle",
          timeout: 30_000,
        });

        // Stabilization delay for async renders (git status polling, mermaid,
        // Radix portals). 3s handles slower static servers in batch mode.
        await page.waitForTimeout(3_000);

        // Run play-function interactions if the story requires them.
        if (story.playInteraction) {
          await story.playInteraction(page);
          // Allow UI to settle after interactions.
          await page.waitForTimeout(500);
        }

        // Capture the visible viewport only — fullPage would include off-screen
        // scrollable content, producing absurdly tall images for stories with
        // long sidebars or chat histories. Stories may also provide a focused
        // clip region (in CSS pixels) for zoomed-in README screenshots.
        const pngBuffer = await page.screenshot({
          type: "png",
          ...(story.clip ? { clip: story.clip } : {}),
        });

        // Convert to WebP (or run custom post-processing).
        // For full-viewport captures, resize from native DPR resolution to TARGET_WIDTH.
        // For clipped captures, preserve the native DPR resolution and only encode to WebP.
        let webpBuffer: Buffer;
        if (story.postProcess) {
          webpBuffer = await story.postProcess(Buffer.from(pngBuffer));
        } else {
          const image = sharp(pngBuffer);
          webpBuffer = story.clip
            ? await image.webp({ quality: WEBP_QUALITY }).toBuffer()
            : await image
                .resize({ width: TARGET_WIDTH, kernel: "lanczos3" })
                .webp({ quality: WEBP_QUALITY })
                .toBuffer();
        }

        await Bun.write(outputPath, webpBuffer);

        // Report dimensions and size.
        const meta = await sharp(webpBuffer).metadata();
        console.log(`  ${meta.width}×${meta.height}  ${formatBytes(webpBuffer.byteLength)}`);
        succeeded.push(story.exportName);
        captured = true;
        break; // Success — no more retries.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          console.warn(`  attempt ${attempt} failed: ${message}`);
        } else {
          console.error(`  FAILED after ${MAX_RETRIES} attempts: ${message}`);
        }
      } finally {
        await page.close();
      }
    }

    if (!captured) {
      failed.push(story.exportName);
    }
  }

  await browser.close();

  // Summary.
  const total = storiesToCapture.length;
  if (failed.length === 0) {
    console.log(`\nCaptured ${succeeded.length}/${total} screenshots`);
  } else {
    console.log(
      `\nCaptured ${succeeded.length}/${total} screenshots (${failed.length} failed: ${failed.join(", ")})`
    );
    process.exit(1);
  }
}

main();
