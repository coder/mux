/**
 * Bash tool stories rendered as lightweight component cards.
 *
 * These stories intentionally avoid full App boot so they stay focused on
 * tool call UI states and remain fast/stable in Storybook.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { userEvent, waitFor } from "@storybook/test";
import { BashBackgroundListToolCall } from "@/browser/features/Tools/BashBackgroundListToolCall";
import { BashBackgroundTerminateToolCall } from "@/browser/features/Tools/BashBackgroundTerminateToolCall";
import { BashOutputToolCall } from "@/browser/features/Tools/BashOutputToolCall";
import { BashToolCall } from "@/browser/features/Tools/BashToolCall";
import { BackgroundBashProvider } from "@/browser/contexts/BackgroundBashContext";
import { lightweightMeta, StoryUiShell } from "./meta.js";

const STORYBOOK_WORKSPACE_ID = "storybook-bash";

const meta = {
  ...lightweightMeta,
  title: "App/Bash",
  decorators: [
    (Story) => (
      <StoryUiShell>
        <BackgroundBashProvider workspaceId={STORYBOOK_WORKSPACE_ID}>
          <Story />
        </BackgroundBashProvider>
      </StoryUiShell>
    ),
  ],
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function ToolShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-2xl space-y-4">{props.children}</div>
    </div>
  );
}

async function expandAllToolCards(canvasElement: HTMLElement) {
  await waitFor(() => {
    const expandIcons = Array.from(canvasElement.querySelectorAll("span")).filter(
      (span) => span.textContent?.trim() === "▶"
    );
    if (expandIcons.length === 0) {
      throw new Error("No expandable tool cards were found.");
    }
  });

  const expandIcons = Array.from(canvasElement.querySelectorAll("span")).filter(
    (span) => span.textContent?.trim() === "▶"
  );

  for (const icon of expandIcons) {
    const header = icon.closest("div.cursor-pointer");
    if (header instanceof HTMLElement) {
      await userEvent.click(header);
    }
  }
}

/**
 * Foreground bash: completed execution plus an in-progress command.
 */
export const Foreground: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="foreground-complete"
        args={{
          script: `#!/bin/bash
set -e

echo "=== Git Status ==="
git status --short

echo "=== Running Tests ==="
npm test 2>&1 | head -20`,
          run_in_background: false,
          timeout_secs: 10,
          display_name: "Foreground",
        }}
        result={{
          success: true,
          output: [
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
          exitCode: 0,
          wall_duration_ms: 1250,
        }}
        status="completed"
      />

      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="foreground-pending"
        args={{
          script: "npm run build",
          run_in_background: false,
          timeout_secs: 60,
          display_name: "Build",
        }}
        status="executing"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);
  },
};

/**
 * Overflow notice: output was truncated and written to a temp file.
 */
export const OverflowNotice: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="overflow"
        args={{
          script: 'rg "ERROR" /var/log/app/*.log',
          run_in_background: false,
          timeout_secs: 5,
          display_name: "Log Scan",
        }}
        result={{
          success: true,
          output: "",
          note: [
            "[OUTPUT OVERFLOW - Total output exceeded display limit: 18432 bytes > 16384 bytes (at line 312)]",
            "",
            "Full output (1250 lines) saved to /home/user/.mux/tmp/bash-1a2b3c4d.txt",
            "",
            "Use selective filtering tools (e.g. grep) to extract relevant information and continue your task",
            "",
            "File will be automatically cleaned up when stream ends.",
          ].join("\n"),
          exitCode: 0,
          wall_duration_ms: 4200,
          truncated: {
            reason: "Total output exceeded display limit: 18432 bytes > 16384 bytes (at line 312)",
            totalLines: 1250,
          },
        }}
        status="completed"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);

    const noticeButton = canvasElement.querySelector('button[aria-label="View notice"]');
    if (noticeButton instanceof HTMLElement) {
      await userEvent.hover(noticeButton);

      const doc = canvasElement.ownerDocument;
      await waitFor(() => {
        const tooltip = doc.querySelector('[role="tooltip"]');
        if (!tooltip) {
          throw new Error("Notice tooltip not shown");
        }
      });
    }
  },
};

/**
 * Background bash workflow: spawn, output polling, list, and terminate.
 */
export const BackgroundWorkflow: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="spawn-dev"
        args={{
          script: "npm run dev",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Dev Server",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_1",
          exitCode: 0,
          wall_duration_ms: 50,
          taskId: "bash:bash_1",
          backgroundProcessId: "bash_1",
        }}
        status="completed"
      />

      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="spawn-build"
        args={{
          script: "npm run build",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Build",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_2",
          exitCode: 0,
          wall_duration_ms: 50,
          taskId: "bash:bash_2",
          backgroundProcessId: "bash_2",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output:
            "  VITE v5.0.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose",
          elapsed_ms: 1200,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_2", timeout_secs: 5 }}
        result={{
          success: true,
          status: "exited",
          output:
            "vite v5.0.0 building for production...\n✓ 1423 modules transformed.\ndist/index.html   0.46 kB │ gzip:  0.30 kB\n✓ built in 2.34s",
          exitCode: 0,
          elapsed_ms: 2340,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5, filter: "ERROR" }}
        result={{
          success: true,
          status: "running",
          output: "[ERROR] Failed to connect to database\n[ERROR] Retry attempt 1 failed",
          elapsed_ms: 420,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output: "",
          elapsed_ms: 150,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_99", timeout_secs: 5 }}
        result={{
          success: false,
          error: "Process not found: bash_99",
        }}
        status="failed"
      />

      <BashBackgroundListToolCall
        args={{}}
        result={{
          success: true,
          processes: [
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
          ],
        }}
        status="completed"
      />

      <BashBackgroundTerminateToolCall
        args={{ process_id: "bash_1" }}
        result={{
          success: true,
          message: "Process bash_1 terminated",
          display_name: "Dev Server",
        }}
        status="completed"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);
  },
};

/**
 * Mixed foreground/background story, including foreground->background migration.
 */
export const Mixed: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="mixed-foreground"
        args={{
          script: "echo 'Hello World'",
          run_in_background: false,
          timeout_secs: 3,
          display_name: "Quick Command",
        }}
        result={{
          success: true,
          output: "Hello World",
          exitCode: 0,
          wall_duration_ms: 12,
        }}
        status="completed"
      />

      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="mixed-background"
        args={{
          script: "npm run build && npm run test",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Build + Test",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_6",
          exitCode: 0,
          wall_duration_ms: 40,
          taskId: "bash:bash_6",
          backgroundProcessId: "bash_6",
        }}
        status="completed"
      />

      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="mixed-migrated"
        args={{
          script: "npm run test:integration",
          run_in_background: false,
          timeout_secs: 30,
          display_name: "Integration Tests",
        }}
        result={{
          success: true,
          output: [
            "Process sent to background with ID: test-suite",
            "",
            "Output so far (3 lines):",
            "Running integration tests...",
            "Test 1: PASS",
            "Test 2: PASS",
            "Test 3: Running...",
          ].join("\n"),
          exitCode: 0,
          wall_duration_ms: 5000,
          taskId: "bash:test-suite",
          backgroundProcessId: "test-suite",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_6", timeout_secs: 5 }}
        result={{
          success: true,
          status: "exited",
          output:
            "FAIL src/utils.test.ts\n  ✕ should parse dates correctly (5 ms)\n\nTests: 1 failed, 1 total",
          exitCode: 1,
          elapsed_ms: 5300,
        }}
        status="completed"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);
  },
};

/**
 * Grouped Bash Output: demonstrates start/end group markers for consecutive polls.
 */
export const GroupedOutput: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="grouped-spawn"
        args={{
          script: "npm run dev",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Dev Server",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_1",
          exitCode: 0,
          wall_duration_ms: 45,
          taskId: "bash:bash_1",
          backgroundProcessId: "bash_1",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        groupPosition="first"
        result={{
          success: true,
          status: "running",
          output: "Starting compilation...",
          elapsed_ms: 110,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        groupPosition="last"
        result={{
          success: true,
          status: "running",
          output: "  VITE v5.0.0  ready in 320 ms\n\n  ➜  Local:   http://localhost:5173/",
          elapsed_ms: 320,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output: "Server healthy",
          elapsed_ms: 60,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_2", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output: "Build in progress",
          elapsed_ms: 180,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{ process_id: "bash_1", timeout_secs: 5 }}
        result={{
          success: true,
          status: "running",
          output: "New request received",
          elapsed_ms: 45,
        }}
        status="completed"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);
  },
};

/**
 * Filter Exclude: compares exclude-mode filtering with regular include filtering.
 */
export const FilterExclude: Story = {
  render: () => (
    <ToolShell>
      <BashToolCall
        workspaceId={STORYBOOK_WORKSPACE_ID}
        toolCallId="filter-spawn"
        args={{
          script: "./scripts/wait_pr_checks.sh 1081",
          run_in_background: true,
          timeout_secs: 60,
          display_name: "Wait PR Checks",
        }}
        result={{
          success: true,
          output: "Background process started with ID: bash_ci",
          exitCode: 0,
          wall_duration_ms: 35,
          taskId: "bash:bash_ci",
          backgroundProcessId: "bash_ci",
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{
          process_id: "bash_ci",
          timeout_secs: 60,
          filter: "⏳",
          filter_exclude: true,
        }}
        result={{
          success: true,
          status: "running",
          output: "",
          elapsed_ms: 60000,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{
          process_id: "bash_ci",
          timeout_secs: 60,
          filter: "⏳",
          filter_exclude: true,
        }}
        result={{
          success: true,
          status: "exited",
          output:
            "✅ All checks passed!\n\n🤖 Checking for unresolved Codex comments...\n\n✅ PR is ready to merge!",
          exitCode: 0,
          elapsed_ms: 180000,
        }}
        status="completed"
      />

      <BashOutputToolCall
        args={{
          process_id: "bash_ci",
          timeout_secs: 5,
          filter: "ERROR",
          filter_exclude: false,
        }}
        result={{
          success: true,
          status: "exited",
          output: "ERROR: Build failed\nERROR: Test suite failed",
          exitCode: 1,
          elapsed_ms: 900,
        }}
        status="completed"
      />
    </ToolShell>
  ),
  play: async ({ canvasElement }) => {
    await expandAllToolCards(canvasElement);
  },
};
