/**
 * Integration tests for workspace forking UX.
 *
 * Regression test: after running `/fork` from a workspace, the newly-created
 * workspace should appear in the sidebar immediately (i.e. without being hidden
 * under an "older" age tier).
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../../testUtils";
import { preloadTestModules } from "../../ipc/setup";
import { isDockerAvailable } from "../../runtime/test-fixtures/ssh-fixture";
import type { RuntimeConfig } from "@/common/types/runtime";

import { createAppHarness } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

// Docker /fork UI flow is covered by non-Docker slash-command UI tests plus Docker fork IPC tests.
// Keep this scenario for local smoke checks, but skip it in CI where Docker startup variance is high.
const dockerForkSlashCommandTest = process.env.CI === "true" ? test.skip : test;

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

      // Seamless fork: no name argument needed; backend auto-generates branch name
      await app.chat.send("/fork");

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

  dockerForkSlashCommandTest(
    "/fork on Docker runtime adds the new workspace to the sidebar immediately",
    async () => {
      if (!(await isDockerAvailable())) return;

      const dockerRuntimeConfig: RuntimeConfig = {
        type: "docker",
        image: "node:20",
      };
      const app = await createAppHarness({
        branchPrefix: "ui-fork-docker",
        runtimeConfig: dockerRuntimeConfig,
      });

      let forkedWorkspaceId: string | null = null;

      try {
        // Seed the Docker workspace with one completed message before /fork so the
        // command has conversation context to duplicate.
        await app.chat.send("Hello from Docker source workspace");
        await app.chat.expectTranscriptContains("Hello from Docker source workspace", 120_000);

        const existingWorkspaceIds = new Set(
          (await app.env.orpc.workspace.list()).map((ws) => ws.id)
        );
        const expectedForkNamePrefix = `${app.metadata.name}-`;

        // Chat controls can remain disabled while Docker runtime provisioning settles.
        // Retry the /fork send until the command can be submitted.
        await waitFor(
          async () => {
            await app.chat.send("/fork");
          },
          { timeout: 180_000 }
        );
        await app.chat.expectTranscriptNotContains("Fork Failed", 30_000);

        await waitFor(
          async () => {
            const allWorkspaces = await app.env.orpc.workspace.list();
            const forkedWorkspace = allWorkspaces.find((workspace) => {
              if (existingWorkspaceIds.has(workspace.id)) {
                return false;
              }
              if (workspace.projectPath !== app.metadata.projectPath) {
                return false;
              }
              if (workspace.runtimeConfig.type !== "docker") {
                return false;
              }
              return workspace.name.startsWith(expectedForkNamePrefix);
            });
            if (!forkedWorkspace) {
              throw new Error("Forked Docker workspace not created yet");
            }
            forkedWorkspaceId = forkedWorkspace.id;
          },
          { timeout: 240_000 }
        );

        if (!forkedWorkspaceId) {
          throw new Error("Missing forked workspace ID after Docker fork");
        }

        await waitFor(
          () => {
            const el = app.view.container.querySelector(
              `[data-workspace-id=\"${forkedWorkspaceId}\"]`
            ) as HTMLElement | null;
            if (!el) {
              throw new Error("Forked Docker workspace not found in sidebar");
            }
          },
          { timeout: 30_000 }
        );
      } finally {
        if (forkedWorkspaceId) {
          await app.env.orpc.workspace
            .remove({ workspaceId: forkedWorkspaceId, options: { force: true } })
            .catch(() => {});
        }

        await app.dispose();
      }
    },
    450_000
  );

  test("context menu Fork chat action adds the new workspace to the sidebar immediately", async () => {
    const app = await createAppHarness({ branchPrefix: "ui-fork-menu" });

    let forkedWorkspaceId: string | null = null;

    try {
      // Ensure the source workspace has a non-zero recency so that age-tier bucketing
      // is active (otherwise "always show one workspace" can mask regressions).
      await app.chat.send("Hello from source workspace");
      await app.chat.expectTranscriptContains("Mock response: Hello from source workspace");

      const sourceDisplayTitle = app.metadata.title ?? app.metadata.name;

      const menuButton = await waitFor(
        () => {
          const btn = app.view.container.querySelector(
            `[aria-label="Workspace actions for ${sourceDisplayTitle}"]`
          ) as HTMLElement | null;
          if (!btn) throw new Error("Workspace actions menu button not found");
          return btn;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(menuButton);

      const forkButton = await waitFor(
        () => {
          const buttons = Array.from(document.querySelectorAll("button"));
          const forkBtn = buttons.find((b) => b.textContent?.includes("Fork chat"));
          if (!forkBtn) throw new Error("Fork button not found in menu");
          return forkBtn as HTMLElement;
        },
        { timeout: 5_000 }
      );
      fireEvent.click(forkButton);

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
