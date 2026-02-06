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
 *   bun run scripts/capture-readme-screenshots.ts --story ProductHero
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

const VIEWPORT = { width: 1600, height: 1171 };
const DEVICE_SCALE_FACTOR = 2;
const WEBP_QUALITY = 90;

const DOCS_IMG_DIR = path.resolve(import.meta.dirname, "..", "docs", "img");

// Storybook title "Docs/README Screenshots" → id prefix "docs-readme-screenshots--"
const STORY_ID_PREFIX = "docs-readme-screenshots--";

/**
 * Story definitions. `playInteraction` is a Playwright callback that replicates
 * the Storybook play function for stories that require user interaction before
 * the screenshot is taken. `postProcess` allows custom Sharp pipelines (e.g.
 * clipping + upscaling for AgentStatusSidebar).
 */
interface StoryDef {
  exportName: string;
  storyId: string;
  outputFile: string;
  /** Replicate the Storybook play function via Playwright interactions. */
  playInteraction?: (page: Page) => Promise<void>;
  /** Custom Sharp post-processing instead of the default full-page → WebP conversion. */
  postProcess?: (pngBuffer: Buffer) => Promise<Buffer>;
}

const STORIES: StoryDef[] = [
  {
    exportName: "ProductHero",
    storyId: `${STORY_ID_PREFIX}product-hero`,
    outputFile: "product-hero.webp",
  },
  {
    exportName: "CodeReview",
    storyId: `${STORY_ID_PREFIX}code-review`,
    outputFile: "code-review.webp",
  },
  {
    exportName: "AgentStatusSidebar",
    storyId: `${STORY_ID_PREFIX}agent-status-sidebar`,
    outputFile: "agent-status.webp",
    // Clip the left sidebar region and upscale to the full viewport size.
    postProcess: async (pngBuffer: Buffer) => {
      // At 2× DPR the sidebar's 288 CSS-px width becomes 576 device pixels.
      const SIDEBAR_WIDTH_PX = 576;
      // Skip the top window-controls region (~95 CSS-px → 190 device pixels).
      const TOP_OFFSET_PX = 190;
      const metadata = await sharp(pngBuffer).metadata();
      const fullHeight = metadata.height ?? VIEWPORT.height * DEVICE_SCALE_FACTOR;

      return sharp(pngBuffer)
        .extract({
          left: 0,
          top: TOP_OFFSET_PX,
          width: SIDEBAR_WIDTH_PX,
          height: fullHeight - TOP_OFFSET_PX,
        })
        .resize({
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          kernel: "lanczos3",
        })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    },
  },
  {
    exportName: "GitStatusPopover",
    storyId: `${STORY_ID_PREFIX}git-status-popover`,
    outputFile: "git-status.webp",
    playInteraction: async (page: Page) => {
      // Wait for git status to render in the ws-diverged row.
      const row = page.locator('[data-workspace-id="ws-diverged"]');
      const plusText = row.getByText("+12.3k");
      await plusText.waitFor({ timeout: 15_000 });

      // Hover to open tooltip.
      await plusText.hover();

      // Wait for the tooltip (portaled to body) to appear.
      const tooltip = page.locator('.bg-modal-bg[data-state="open"]');
      await tooltip.waitFor({ timeout: 10_000 });

      // Click "Commits" tab in the tooltip.
      await tooltip.getByText("Commits").click();

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
    playInteraction: async (page: Page) => {
      // Hover the project row to reveal the manage-secrets button.
      const projectRow = page.locator('[data-project-path="/home/user/projects/mux"]');
      await projectRow.waitFor({ timeout: 10_000 });
      await projectRow.hover();

      // Click "Manage secrets" button.
      const manageBtn = projectRow.getByRole("button", { name: /manage secrets/i });
      await manageBtn.click();

      // Wait for the modal to appear with secrets content.
      await page.getByText(/Manage Secrets/i).waitFor({ timeout: 10_000 });
      await page.getByText(/GITHUB_TOKEN/i).waitFor({ timeout: 5_000 });
    },
  },
  {
    exportName: "CostsTabRich",
    storyId: `${STORY_ID_PREFIX}costs-tab-rich`,
    outputFile: "costs-tab.webp",
  },
  {
    exportName: "OpportunisticCompactionTooltip",
    storyId: `${STORY_ID_PREFIX}opportunistic-compaction-tooltip`,
    outputFile: "opportunistic-compaction.webp",
    playInteraction: async (page: Page) => {
      // Wait for costs to render.
      await page.getByText(/cache create/i).waitFor({ timeout: 15_000 });

      // Hover the "Start Here" button to show the compaction tooltip.
      const startHere = page.getByRole("button", { name: "Start Here" });
      await startHere.hover();

      // Wait for the tooltip text to appear.
      await page
        .getByText("Replace all chat history with this message")
        .waitFor({ timeout: 10_000 });
    },
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
    console.log(`Capturing ${story.exportName} → ${path.relative(process.cwd(), outputPath)}...`);

    const page = await context.newPage();
    try {
      // Navigate and wait for network idle + DOM stability.
      await page.goto(iframeUrl(story.storyId), {
        waitUntil: "networkidle",
        timeout: 30_000,
      });

      // Brief stabilization delay for async renders (git status polling, mermaid, etc.).
      await page.waitForTimeout(2_000);

      // Run play-function interactions if the story requires them.
      if (story.playInteraction) {
        await story.playInteraction(page);
        // Allow UI to settle after interactions.
        await page.waitForTimeout(500);
      }

      // Capture full-page screenshot as PNG buffer.
      const pngBuffer = await page.screenshot({ type: "png", fullPage: true });

      // Convert to WebP (or run custom post-processing).
      let webpBuffer: Buffer;
      if (story.postProcess) {
        webpBuffer = await story.postProcess(Buffer.from(pngBuffer));
      } else {
        webpBuffer = await sharp(pngBuffer).webp({ quality: WEBP_QUALITY }).toBuffer();
      }

      await Bun.write(outputPath, webpBuffer);

      // Report dimensions and size.
      const meta = await sharp(webpBuffer).metadata();
      console.log(`  ${meta.width}×${meta.height}  ${formatBytes(webpBuffer.byteLength)}`);
      succeeded.push(story.exportName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAILED: ${message}`);
      failed.push(story.exportName);
    } finally {
      await page.close();
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
