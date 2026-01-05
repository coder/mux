/**
 * Integration tests for agent picker (AgentModePicker) component.
 *
 * Tests cover:
 * - Built-in agents appear in dropdown
 * - Custom project agents appear alongside built-ins
 * - Refresh button reloads agents after filesystem changes
 * - Broken agent definitions show error indicators
 */

import { fireEvent, waitFor } from "@testing-library/react";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open the agent picker dropdown by clicking the trigger button.
 * Waits until at least one agent row is visible.
 */
async function openAgentPicker(container: HTMLElement): Promise<void> {
  const trigger = await waitFor(
    () => {
      const btn = container.querySelector('[aria-label="Select agent"]') as HTMLElement;
      if (!btn) throw new Error("Agent picker trigger not found");
      return btn;
    },
    { timeout: 5_000 }
  );
  fireEvent.click(trigger);

  // Wait for dropdown to appear with agent rows
  await waitFor(
    () => {
      const dropdown = container.querySelector('[placeholder="Search agents…"]');
      if (!dropdown) throw new Error("Agent picker dropdown not open");

      // Also wait for at least one agent row to appear (agents loaded)
      const rows = container.querySelectorAll("[data-agent-id]");
      if (rows.length === 0) throw new Error("No agents loaded yet");
    },
    { timeout: 10_000 }
  );
}

/**
 * Get all agent names visible in the dropdown.
 */
function getVisibleAgentNames(container: HTMLElement): string[] {
  // Use data-agent-id to find agent rows, then extract names
  const rows = container.querySelectorAll("[data-agent-id]");
  return Array.from(rows).map((row) => {
    const nameSpan = row.querySelector('[data-testid="agent-name"]');
    return nameSpan?.textContent ?? "";
  });
}

/**
 * Get the agent ID by name from the dropdown.
 */
function getAgentIdByName(container: HTMLElement, name: string): string | null {
  const rows = container.querySelectorAll("[data-agent-id]");
  for (const row of Array.from(rows)) {
    const nameSpan = row.querySelector('[data-testid="agent-name"]');
    if (nameSpan?.textContent === name) {
      return row.getAttribute("data-agent-id");
    }
  }
  return null;
}

/**
 * Click the refresh button in the agent picker dropdown.
 */
async function clickRefreshButton(container: HTMLElement): Promise<void> {
  const refreshBtn = await waitFor(
    () => {
      const btn = container.querySelector('[aria-label="Reload agents"]') as HTMLElement;
      if (!btn) throw new Error("Refresh button not found");
      return btn;
    },
    { timeout: 2_000 }
  );
  fireEvent.click(refreshBtn);
}

/**
 * Wait for refresh to complete (spinning icon stops).
 */
async function waitForRefreshComplete(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const svg = container.querySelector('[aria-label="Reload agents"] svg');
      if (!svg) throw new Error("Refresh icon not found");
      const classes = svg.getAttribute("class") ?? "";
      if (classes.includes("animate-spin")) {
        throw new Error("Still refreshing");
      }
    },
    { timeout: 10_000 }
  );
}

/**
 * Check if an agent has a help indicator (? button with tooltip).
 */
function agentHasHelpIndicator(container: HTMLElement, agentName: string): boolean {
  const rows = container.querySelectorAll("[data-agent-id]");
  for (const row of Array.from(rows)) {
    const nameSpan = row.querySelector('[data-testid="agent-name"]');
    if (nameSpan?.textContent === agentName) {
      // Look for the ? help indicator
      return row.textContent?.includes("?") ?? false;
    }
  }
  return false;
}

/**
 * Create a custom agent definition file in the workspace.
 */
async function createAgentFile(
  workspacePath: string,
  agentId: string,
  content: string
): Promise<void> {
  const agentsDir = path.join(workspacePath, ".mux", "agents");
  await fs.mkdir(agentsDir, { recursive: true });
  await fs.writeFile(path.join(agentsDir, `${agentId}.md`), content);
}

/**
 * Remove a custom agent definition file from the workspace.
 */
async function removeAgentFile(workspacePath: string, agentId: string): Promise<void> {
  const filePath = path.join(workspacePath, ".mux", "agents", `${agentId}.md`);
  try {
    await fs.unlink(filePath);
  } catch {
    // File might not exist
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describeIntegration("Agent Picker (UI)", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("built-in agents appear in dropdown", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        const agentNames = getVisibleAgentNames(view.container);

        // Built-in agents should be present
        expect(agentNames).toContain("Exec");
        expect(agentNames).toContain("Plan");

        // Check IDs match
        expect(getAgentIdByName(view.container, "Exec")).toBe("exec");
        expect(getAgentIdByName(view.container, "Plan")).toBe("plan");
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("custom workspace agents appear alongside built-ins", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // With workspaceId provided, agents are discovered from workspace worktree path.
      // This allows iterating on agent definitions per-workspace.
      const workspacePath = metadata.namedWorkspacePath;

      // Create a custom agent in the workspace worktree
      const customAgentContent = `---
name: Code Review
description: Review code changes for quality and best practices.
base: exec
ui:
  color: "#ff6b6b"
tools:
  remove:
    - file_edit_.*
---

You are a code review agent. Review code for quality, readability, and best practices.
`;
      await createAgentFile(workspacePath, "code-review", customAgentContent);

      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        const agentNames = getVisibleAgentNames(view.container);

        // Both built-in and custom agents should appear
        expect(agentNames).toContain("Exec");
        expect(agentNames).toContain("Plan");
        expect(agentNames).toContain("Code Review");

        // Custom agent should have correct ID
        expect(getAgentIdByName(view.container, "Code Review")).toBe("code-review");

        // Custom agent with description should have help indicator
        expect(agentHasHelpIndicator(view.container, "Code Review")).toBe(true);
      } finally {
        // Cleanup custom agent
        await removeAgentFile(workspacePath, "code-review");
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("refresh button reloads agents after filesystem changes", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      // With workspaceId provided, agents are discovered from workspace worktree path.
      const workspacePath = metadata.namedWorkspacePath;

      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        // Verify custom agent doesn't exist yet
        let agentNames = getVisibleAgentNames(view.container);
        expect(agentNames).not.toContain("Hot Reload Test");

        // Create a new agent in the workspace worktree while dropdown is open
        const newAgentContent = `---
name: Hot Reload Test
description: Test agent for verifying hot reload.
base: exec
---

This is a test agent.
`;
        await createAgentFile(workspacePath, "hot-reload-test", newAgentContent);

        // Click refresh button
        await clickRefreshButton(view.container);
        await waitForRefreshComplete(view.container);

        // New agent should now appear
        agentNames = getVisibleAgentNames(view.container);
        expect(agentNames).toContain("Hot Reload Test");
      } finally {
        // Cleanup
        await removeAgentFile(workspacePath, "hot-reload-test");
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("agents with descriptions show help indicators", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        // Built-in agents have descriptions, so they should have help indicators
        expect(agentHasHelpIndicator(view.container, "Exec")).toBe(true);
        expect(agentHasHelpIndicator(view.container, "Plan")).toBe(true);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("selecting an agent updates the picker trigger", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Get initial agent name from trigger
        const getTriggerText = () => {
          const trigger = view.container.querySelector('[aria-label="Select agent"]');
          return trigger?.textContent?.replace(/[⌘⌃⇧\d]/g, "").trim() ?? "";
        };

        await openAgentPicker(view.container);

        // Click on Plan agent
        const dropdown = view.container
          .querySelector('[placeholder="Search agents…"]')
          ?.closest("div")?.parentElement;
        const rows = dropdown?.querySelectorAll('[role="button"]') ?? [];
        let planRow: HTMLElement | null = null;
        for (const row of Array.from(rows)) {
          if (row.textContent?.includes("Plan")) {
            planRow = row as HTMLElement;
            break;
          }
        }
        expect(planRow).toBeTruthy();
        fireEvent.click(planRow!);

        // Wait for dropdown to close and trigger to update
        await waitFor(
          () => {
            const dropdown = view.container.querySelector('[placeholder="Search agents…"]');
            if (dropdown) throw new Error("Dropdown still open");
          },
          { timeout: 2_000 }
        );

        // Trigger should now show "Plan"
        await waitFor(
          () => {
            const text = getTriggerText();
            if (!text.includes("Plan")) {
              throw new Error(`Expected "Plan" in trigger, got "${text}"`);
            }
          },
          { timeout: 2_000 }
        );
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);

  test("agent picker shows agents on project page (no workspace)", async () => {
    // This test reproduces a bug where the agent picker shows "No matching agents"
    // on the new workspace creation page, even though exec agent is selected.
    // The bug occurs because ModeProvider doesn't load agents when there's no workspaceId.
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-agent-picker-project");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and archive a workspace to register the project (setup - OK to use API)
    const createResult = await env.orpc.workspace.create({
      projectPath,
      branchName,
      trunkBranch,
    });
    if (!createResult.success) throw new Error(createResult.error);
    const metadata = createResult.metadata;
    const workspaceId = metadata.id;

    await env.orpc.workspace.archive({ workspaceId });

    const cleanupDom = installDom();
    // Disable tutorial to prevent it from blocking UI interactions
    globalThis.localStorage.setItem(
      "tutorialState",
      JSON.stringify({ disabled: true, completed: {} })
    );

    const view = renderApp({ apiClient: env.orpc, metadata });

    try {
      await view.waitForReady();

      // Click project to navigate to project page (new workspace creation)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
          if (!el) throw new Error("Project not found");
          return el as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(projectRow);

      // Wait for project page (textarea for new workspace creation)
      await waitFor(
        () => {
          const textarea = view.container.querySelector("textarea");
          if (!textarea) throw new Error("Project page not rendered");
        },
        { timeout: 5_000 }
      );

      // Open agent picker
      await openAgentPicker(view.container);

      // Should show agents, not "No matching agents"
      const agentNames = getVisibleAgentNames(view.container);
      expect(agentNames.length).toBeGreaterThan(0);
      expect(agentNames).toContain("Exec");
      expect(agentNames).toContain("Plan");
    } finally {
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  // Note: Search filtering test is skipped because happy-dom doesn't reliably
  // trigger onChange handlers. The filtering logic is covered by unit tests.
  test.skip("search filters agents by name and id", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();
      const view = renderApp({ apiClient: env.orpc, metadata });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await openAgentPicker(view.container);

        // Get initial count
        let agentNames = getVisibleAgentNames(view.container);
        const initialCount = agentNames.length;
        expect(initialCount).toBeGreaterThanOrEqual(2); // At least exec, plan

        // Type in search
        const searchInput = view.container.querySelector(
          '[placeholder="Search agents…"]'
        ) as HTMLInputElement;
        expect(searchInput).toBeTruthy();
        fireEvent.change(searchInput, { target: { value: "exec" } });

        // Should filter to just exec
        await waitFor(() => {
          agentNames = getVisibleAgentNames(view.container);
          expect(agentNames.length).toBeLessThan(initialCount);
          expect(agentNames).toContain("Exec");
        });

        // Clear and search by partial name
        fireEvent.change(searchInput, { target: { value: "pla" } });
        await waitFor(() => {
          agentNames = getVisibleAgentNames(view.container);
          expect(agentNames).toContain("Plan");
        });
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 30_000);
});
