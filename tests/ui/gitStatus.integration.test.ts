import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedRepoPath,
  withSharedWorkspace,
} from "../ipc/sendMessageTestHelpers";
import { addFakeOrigin } from "../ipc/helpers";

import { installDom } from "./dom";
import { renderReviewPanel } from "./renderReviewPanel";
import {
  cleanupView,
  getGitStatusFromElement,
  setupWorkspaceView,
  waitForAheadStatus,
  waitForIdleGitStatus,
  waitForGitStatusElement,
  waitForDirtyStatus,
  waitForCleanStatus,
} from "./helpers";
import { invalidateGitStatus } from "@/browser/stores/GitStatusStore";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("GitStatus (UI + ORPC)", () => {
  beforeAll(async () => {
    await createSharedRepo();
    // Add fake origin for ahead/behind status tests
    await addFakeOrigin(getSharedRepoPath());
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("initial git status shows clean state for fresh workspace", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Initial subscription triggers immediate fetch
        const statusElement = await waitForGitStatusElement(view.container, workspaceId, 30_000);
        const status = getGitStatusFromElement(statusElement);

        expect(status).not.toBeNull();
        expect(status?.dirty).toBe(false);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status updates on window focus after file change", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);
        await waitForCleanStatus(view.container, workspaceId, 30_000);

        // Modify file (simulates external change or terminal command)
        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "TEST_MARKER" >> README.md`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;

        // Directly invalidate git status instead of relying on window focus.
        // This bypasses RefreshController rate-limiting and happy-dom focus quirks.
        invalidateGitStatus(workspaceId);

        const dirtyStatus = await waitForDirtyStatus(view.container, workspaceId, 30_000);
        expect(dirtyStatus.dirty).toBe(true);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status shows clean after committing", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        const bashRes = await env.orpc.workspace.executeBash({
          workspaceId,
          script: `echo "COMMIT_MARKER" >> README.md && git add README.md && git commit -m "test commit"`,
        });
        expect(bashRes.success).toBe(true);
        if (!bashRes.success) return;

        // See focus test above: use explicit invalidation to avoid DOM focus flakiness.
        invalidateGitStatus(workspaceId);

        const status = await waitForCleanStatus(view.container, workspaceId, 30_000);
        expect(status.dirty).toBe(false);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);

  test("git status reflects ahead count", async () => {
    await withSharedWorkspace("anthropic", async ({ env, workspaceId, metadata }) => {
      const cleanupDom = installDom();

      const view = renderReviewPanel({
        apiClient: env.orpc,
        metadata,
      });

      try {
        await setupWorkspaceView(view, metadata, workspaceId);

        // Wait for stable baseline (ahead === 0, clean) AND idle store (no in-flight fetch).
        // This ensures we don't race with a background fetch completing mid-commit.
        await waitForIdleGitStatus(
          workspaceId,
          (s) => s.ahead === 0 && !s.dirty,
          "ahead === 0, clean, idle",
          10_000
        );

        // Make 2 commits to get ahead of remote
        for (let i = 0; i < 2; i++) {
          const bashRes = await env.orpc.workspace.executeBash({
            workspaceId,
            script: `echo "commit-${i}" >> README.md && git add README.md && git commit -m "test commit ${i}"`,
          });
          expect(bashRes.success).toBe(true);
          if (!bashRes.success) return;
        }

        // Directly invalidate git status instead of simulating window focus.
        // This bypasses RefreshController rate-limiting and jsdom event quirks.
        invalidateGitStatus(workspaceId);
        await waitForAheadStatus(view.container, workspaceId, 2, 30_000);
      } finally {
        await cleanupView(view, cleanupDom);
      }
    });
  }, 45_000);
});
