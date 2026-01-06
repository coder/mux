/**
 * UI smoke test for workspace name generation.
 *
 * Verifies that typing a message in creation mode triggers name generation
 * and displays the result in the UI. This test uses a real LLM.
 *
 * Robust testing of the model selection fallback logic is in:
 * - src/node/services/modelSelectionFallback.test.ts (unit tests with mocks)
 * - tests/ipc/nameGeneration.test.ts (backend API with real LLM)
 */

import { act, fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getInputKey, getPendingScopeId } from "@/common/constants/storage";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Name generation UI flow", () => {
  beforeAll(async () => {
    await createSharedRepo();
  }, 30_000);

  afterAll(async () => {
    await cleanupSharedRepo();
  }, 30_000);

  test("shows generated name when typing message in creation mode", async () => {
    const env = getSharedEnv();
    const projectPath = getSharedRepoPath();
    const branchName = generateBranchName("test-name-gen");
    const trunkBranch = await detectDefaultTrunkBranch(projectPath);

    // Create and archive a workspace to register the project in sidebar (setup - OK to use API)
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

      // Click project to navigate to creation mode (no workspace selected)
      const projectRow = await waitFor(
        () => {
          const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
          if (!el) throw new Error("Project not found in sidebar");
          return el as HTMLElement;
        },
        { timeout: 10_000 }
      );
      fireEvent.click(projectRow);

      // Wait for creation controls to appear (textarea + workspace name input)
      await waitFor(
        () => {
          const el = view.container.querySelector("textarea") as HTMLTextAreaElement;
          if (!el) throw new Error("Creation textarea not found");
        },
        { timeout: 5_000 }
      );

      // Set input text via persisted state (happy-dom fireEvent.change can be flaky)
      // This mimics how ChatHarness.send() works
      const pendingScopeId = getPendingScopeId(projectPath);
      const inputKey = getInputKey(pendingScopeId);
      act(() => {
        updatePersistedState(inputKey, "Fix the sidebar layout bug on mobile devices");
      });

      // Wait for the workspace name input to show a generated name
      // Name format: lowercase letters/numbers/hyphens with 4-char suffix (e.g., "sidebar-a1b2")
      await waitFor(
        () => {
          const input = view.container.querySelector("#workspace-name") as HTMLInputElement;
          if (!input) throw new Error("Workspace name input not found");

          const name = input.value;
          // Check if name matches expected format: word(s)-xxxx where xxxx is the suffix
          if (!name || !/^[a-z0-9-]+-[a-z0-9]{4}$/.test(name)) {
            throw new Error(`Name not generated yet or invalid format: "${name}"`);
          }
        },
        { timeout: 30_000 } // LLM call can take time
      );

      // Verify the generated name is valid
      const nameInput = view.container.querySelector("#workspace-name") as HTMLInputElement;
      const generatedName = nameInput.value;
      expect(generatedName).toMatch(/^[a-z0-9-]+-[a-z0-9]{4}$/);
      expect(generatedName.length).toBeLessThanOrEqual(30);
    } finally {
      // Cleanup: remove the archived workspace
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 60_000);
});
