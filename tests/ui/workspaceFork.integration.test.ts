/**
 * Integration tests for workspace forking UX.
 *
 * Regression test: after running `/fork <name>` from a workspace, the newly-created
 * workspace should appear in the sidebar immediately (i.e. without being hidden
 * under an "older" age tier).
 */

import "./dom";
import { waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import { preloadTestModules } from "../ipc/setup";
import { generateBranchName } from "../ipc/helpers";

import { createAppHarness } from "./harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Workspace Fork (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("/fork adds the new workspace to the sidebar immediately", async () => {
    const app = await createAppHarness({ branchPrefix: "ui-fork" });

    let forkedWorkspaceId: string | null = null;

    try {
      // Ensure the source workspace has a non-zero recency so that age-tier bucketing
      // is active (otherwise "always show one workspace" can mask regressions).
      await app.chat.send("Hello from source workspace");
      await app.chat.expectTranscriptContains("Mock response: Hello from source workspace");

      const forkBranch = generateBranchName("ui-fork-child");
      await app.chat.send(`/fork ${forkBranch}`);

      // Wait for navigation to the forked workspace.
      await waitFor(
        () => {
          const path = window.location.pathname;
          if (!path.startsWith("/workspace/")) {
            throw new Error(`Unexpected path after fork: ${path}`);
          }

          const currentId = decodeURIComponent(path.slice("/workspace/".length));
          if (currentId === app.workspaceId) {
            throw new Error("Still on source workspace after fork");
          }

          forkedWorkspaceId = currentId;
        },
        { timeout: 10_000 }
      );

      if (!forkedWorkspaceId) {
        throw new Error("Missing forked workspace ID after navigation");
      }

      // KEY ASSERTION: the new workspace should appear in the sidebar without requiring
      // expanding an "Older than X days" tier.
      await waitFor(
        () => {
          const el = app.view.container.querySelector(
            `[data-workspace-id=\"${forkedWorkspaceId}\"]`
          ) as HTMLElement | null;
          if (!el) {
            throw new Error("Forked workspace not found in sidebar");
          }
        },
        { timeout: 1_000 }
      );
    } finally {
      if (forkedWorkspaceId) {
        await app.env.orpc.workspace
          .remove({ workspaceId: forkedWorkspaceId, options: { force: true } })
          .catch(() => {});
      }

      await app.dispose();
    }
  }, 60_000);
});
