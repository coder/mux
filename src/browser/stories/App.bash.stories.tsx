/**
 * Bash tool stories - consolidated to 3 stories covering full UI complexity
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import {
  STABLE_TIMESTAMP,
  createUserMessage,
  createAssistantMessage,
  createBashTool,
  createPendingTool,
  createBackgroundBashTool,
  createMigratedBashTool,
  createBashOutputTool,
  createBashOutputErrorTool,
  createBashBackgroundListTool,
  createBashBackgroundTerminateTool,
} from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";
import { userEvent, waitFor } from "@storybook/test";

/**
 * Helper to expand all bash tool calls in a story.
 * Waits for messages to load, then clicks on the ▶ expand icons to expand tool details.
 */
async function expandAllBashTools(canvasElement: HTMLElement) {
  // Wait for messages to finish loading (non-racy: uses actual loading state)
  await waitFor(
    () => {
      const messageWindow = canvasElement.querySelector('[data-testid="message-window"]');
      if (!messageWindow || messageWindow.getAttribute("data-loaded") !== "true") {
        throw new Error("Messages not loaded yet");
      }
    },
    { timeout: 5000 }
  );

  // Now find and expand all tool icons
  await waitFor(
    async () => {
      const allSpans = canvasElement.querySelectorAll("span");
      const expandIcons = Array.from(allSpans).filter((span) => span.textContent?.trim() === "▶");
      if (expandIcons.length === 0) {
        throw new Error("No expand icons found");
      }
      for (const icon of expandIcons) {
        const header = icon.closest("[class*='cursor-pointer']");
        if (header) {
          await userEvent.click(header as HTMLElement);
        }
      }
    },
    { timeout: 5000 }
  );

  // Wait for focus auto-select timer, then blur
  await new Promise((resolve) => setTimeout(resolve, 150));
  (document.activeElement as HTMLElement)?.blur();
}

export default {
  ...appMeta,
  title: "App/Bash",
};

/**
 * Foreground bash: complete execution with multi-line script + waiting state
 */
export const Foreground: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-bash",
          messages: [
            // Completed foreground bash with multi-line script
            createUserMessage("msg-1", "Check project status", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-2", "Let me check the git status and run tests:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [
                createBashTool(
                  "call-1",
                  `#!/bin/bash
set -e

# Check git status
echo "=== Git Status ==="
git status --short

# Run tests
echo "=== Running Tests ==="
npm test 2>&1 | head -20`,
                  [
                    "=== Git Status ===",
                    " M src/api/users.ts",
                    " M src/auth/jwt.ts",
                    "?? src/api/users.test.ts",
                    "",
                    "=== Running Tests ===",
                    "PASS src/api/users.test.ts",
                    "  ✓ should authenticate (24ms)",
                    "  ✓ should reject invalid tokens (18ms)",
                    "",
                    "Tests: 2 passed, 2 total",
                  ].join("\n"),
                  0,
                  10,
                  1250
                ),
              ],
            }),
            // Pending foreground bash (waiting state)
            createUserMessage("msg-3", "Run the build", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-4", "Running the build:", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createPendingTool("call-2", "bash", {
                  script: "npm run build",
                  run_in_background: false,
                  display_name: "Build",
                  timeout_secs: 60,
                }),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expandAllBashTools(canvasElement);
  },
};

/**
 * Background bash workflow: spawn, output states (running/exited/error/filtered/empty),
 * process list, and terminate
 */
export const BackgroundWorkflow: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            // 1. Spawn background process
            createUserMessage("msg-1", "Start a dev server and run build", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 600000,
            }),
            createAssistantMessage("msg-2", "Starting both in background.", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 590000,
              toolCalls: [
                createBackgroundBashTool("call-1", "npm run dev", "bash_1", "Dev Server"),
                createBackgroundBashTool("call-2", "npm run build", "bash_2", "Build"),
              ],
            }),
            // 2. Output: running process
            createUserMessage("msg-3", "Check dev server", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 500000,
            }),
            createAssistantMessage("msg-4", "Dev server output:", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 490000,
              toolCalls: [
                createBashOutputTool(
                  "call-3",
                  "bash_1",
                  "  VITE v5.0.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose",
                  "running"
                ),
              ],
            }),
            // 3. Output: exited successfully
            createUserMessage("msg-5", "Check build", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 400000,
            }),
            createAssistantMessage("msg-6", "Build completed:", {
              historySequence: 6,
              timestamp: STABLE_TIMESTAMP - 390000,
              toolCalls: [
                createBashOutputTool(
                  "call-4",
                  "bash_2",
                  "vite v5.0.0 building for production...\n✓ 1423 modules transformed.\ndist/index.html   0.46 kB │ gzip:  0.30 kB\n✓ built in 2.34s",
                  "exited",
                  0
                ),
              ],
            }),
            // 4. Output: filtered + no new output
            createUserMessage("msg-7", "Show errors from dev server, then check for updates", {
              historySequence: 7,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-8", "Filtered errors and checking for updates:", {
              historySequence: 8,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createBashOutputTool(
                  "call-5",
                  "bash_1",
                  "[ERROR] Failed to connect to database\n[ERROR] Retry attempt 1 failed",
                  "running",
                  undefined,
                  "ERROR"
                ),
                createBashOutputTool("call-6", "bash_1", "", "running"),
              ],
            }),
            // 5. Output: process not found error
            createUserMessage("msg-9", "Check bash_99", {
              historySequence: 9,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-10", "Checking that process:", {
              historySequence: 10,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [
                createBashOutputErrorTool("call-7", "bash_99", "Process not found: bash_99"),
              ],
            }),
            // 6. List all processes (shows various states)
            createUserMessage("msg-11", "List all processes", {
              historySequence: 11,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-12", "Background processes:", {
              historySequence: 12,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashBackgroundListTool("call-8", [
                  {
                    process_id: "bash_1",
                    status: "running",
                    script: "npm run dev",
                    uptime_ms: 500000,
                    display_name: "Dev Server",
                  },
                  {
                    process_id: "bash_2",
                    status: "exited",
                    script: "npm run build",
                    uptime_ms: 120000,
                    exitCode: 0,
                  },
                  {
                    process_id: "bash_3",
                    status: "killed",
                    script: "npm run long-task",
                    uptime_ms: 45000,
                    exitCode: 143,
                  },
                ]),
              ],
            }),
            // 7. Terminate
            createUserMessage("msg-13", "Stop the dev server", {
              historySequence: 13,
              timestamp: STABLE_TIMESTAMP - 50000,
            }),
            createAssistantMessage("msg-14", "Terminating:", {
              historySequence: 14,
              timestamp: STABLE_TIMESTAMP - 40000,
              toolCalls: [createBashBackgroundTerminateTool("call-9", "bash_1", "Dev Server")],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expandAllBashTools(canvasElement);
  },
};

/**
 * Mixed: foreground and background bash side-by-side comparison
 */
export const Mixed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [
            createUserMessage("msg-1", "Run a quick command and a long one", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll run the quick one normally and the long one in background.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  // Foreground: quick command
                  createBashTool("call-1", "echo 'Hello World'", "Hello World", 0, 3, 12),
                  // Background: long-running (explicit run_in_background=true)
                  createBackgroundBashTool("call-2", "npm run build && npm run test", "bash_6"),
                ],
              }
            ),
            // Migrated foreground→background (user clicked "Background" button)
            createUserMessage("msg-3", "Run a long test suite", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 200000,
            }),
            createAssistantMessage("msg-4", "Running tests:", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 190000,
              toolCalls: [
                // Shows "backgrounded" status (cyan) because it started as foreground
                createMigratedBashTool(
                  "call-3",
                  "npm run test:integration",
                  "test-suite",
                  "Integration Tests",
                  "Running integration tests...\nTest 1: PASS\nTest 2: PASS\nTest 3: Running..."
                ),
              ],
            }),
            // Check background output
            createUserMessage("msg-5", "How did the build go?", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-6", "The build failed:", {
              historySequence: 6,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                createBashOutputTool(
                  "call-4",
                  "bash_6",
                  "FAIL src/utils.test.ts\n  ✕ should parse dates correctly (5 ms)\n\nTests: 1 failed, 1 total",
                  "exited",
                  1
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expandAllBashTools(canvasElement);
  },
};

/**
 * Story: Grouped Bash Output
 * Demonstrates the collapsing of consecutive bash_output calls to the same process.
 * Grouping is computed at render-time (not as a message transformation).
 * Shows:
 * - 5 consecutive output calls to same process: first, collapsed indicator, last
 * - Group position labels (🔗 start/end) on first and last items
 * - Non-grouped bash_output calls for comparison (groups of 1-2)
 * - Mixed process IDs are not grouped together
 */
export const GroupedOutput: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-grouped-output",
          messages: [
            // Background process started
            createUserMessage("msg-1", "Start a dev server and monitor it", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 800000,
            }),
            createAssistantMessage("msg-2", "Starting dev server:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 790000,
              toolCalls: [
                createBackgroundBashTool("call-1", "npm run dev", "bash_1", "Dev Server"),
              ],
            }),
            // Multiple consecutive output checks (will be grouped)
            createUserMessage("msg-3", "Keep checking the server output", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 700000,
            }),
            createAssistantMessage("msg-4", "Monitoring server output:", {
              historySequence: 4,
              timestamp: STABLE_TIMESTAMP - 690000,
              toolCalls: [
                // These 5 consecutive calls will be collapsed to 3 items
                createBashOutputTool("call-2", "bash_1", "Starting compilation...", "running"),
                createBashOutputTool("call-3", "bash_1", "Compiling src/index.ts...", "running"),
                createBashOutputTool("call-4", "bash_1", "Compiling src/utils.ts...", "running"),
                createBashOutputTool("call-5", "bash_1", "Compiling src/components/...", "running"),
                createBashOutputTool(
                  "call-6",
                  "bash_1",
                  "  VITE v5.0.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/",
                  "running"
                ),
              ],
            }),
            // Non-grouped output (only 2 consecutive calls - no grouping)
            createUserMessage("msg-5", "Check both servers briefly", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 500000,
            }),
            createAssistantMessage("msg-6", "Checking servers:", {
              historySequence: 6,
              timestamp: STABLE_TIMESTAMP - 490000,
              toolCalls: [
                // Only 2 calls - no grouping
                createBashOutputTool("call-7", "bash_1", "Server healthy", "running"),
                createBashOutputTool("call-8", "bash_1", "", "running"),
              ],
            }),
            // Mixed: different process IDs (no grouping across processes)
            createUserMessage("msg-7", "Check dev server and build process", {
              historySequence: 7,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-8", "Status of both processes:", {
              historySequence: 8,
              timestamp: STABLE_TIMESTAMP - 290000,
              toolCalls: [
                createBashOutputTool("call-9", "bash_1", "Server running", "running"),
                createBashOutputTool("call-10", "bash_2", "Build in progress", "running"),
                createBashOutputTool("call-11", "bash_1", "New request received", "running"),
              ],
            }),
          ],
        })
      }
    />
  ),
};

/**
 * Story: Filter Exclude
 * Demonstrates the filter_exclude parameter for bash_output.
 * Shows both regular filter (include) and filter_exclude (exclude) modes.
 */
export const FilterExclude: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-filter-exclude",
          messages: [
            // Background process started (CI checks)
            createUserMessage("msg-1", "Run CI checks and wait for completion", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 400000,
            }),
            createAssistantMessage("msg-2", "Starting CI checks:", {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 390000,
              toolCalls: [
                createBackgroundBashTool(
                  "call-1",
                  "./scripts/wait_pr_checks.sh 1081",
                  "bash_ci",
                  "Wait PR Checks"
                ),
              ],
            }),
            // Polling with filter_exclude to skip progress spam
            createUserMessage("msg-3", "Wait for the result", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-4",
              "Waiting for CI with filter_exclude to skip progress messages:",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  // First call - using filter_exclude to skip ⏳ lines
                  createBashOutputTool(
                    "call-2",
                    "bash_ci",
                    "", // No meaningful output yet (⏳ lines were excluded)
                    "running",
                    undefined,
                    "⏳", // filter pattern
                    60, // long timeout
                    true // filter_exclude = true
                  ),
                  // Second call - still waiting, excluded lines don't wake us
                  createBashOutputTool(
                    "call-3",
                    "bash_ci",
                    "✅ All checks passed!\n\n🤖 Checking for unresolved Codex comments...\n\n✅ PR is ready to merge!",
                    "exited",
                    0,
                    "⏳",
                    60,
                    true
                  ),
                ],
              }
            ),
            // Comparison: regular filter (include mode)
            createUserMessage("msg-5", "Show an example with regular filter", {
              historySequence: 5,
              timestamp: STABLE_TIMESTAMP - 100000,
            }),
            createAssistantMessage("msg-6", "Regular filter only shows matching lines:", {
              historySequence: 6,
              timestamp: STABLE_TIMESTAMP - 90000,
              toolCalls: [
                // Regular filter - include only ERROR lines
                createBashOutputTool(
                  "call-4",
                  "bash_ci",
                  "ERROR: Build failed\nERROR: Test suite failed",
                  "exited",
                  1,
                  "ERROR", // filter pattern (include mode)
                  5,
                  false // filter_exclude = false (default)
                ),
              ],
            }),
          ],
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    await expandAllBashTools(canvasElement);
  },
};
