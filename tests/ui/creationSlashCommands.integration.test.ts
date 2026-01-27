/**
 * Integration tests for slash commands in workspace creation mode.
 */

import { fireEvent, waitFor } from "@testing-library/react";

import { shouldRunIntegrationTests } from "../testUtils";
import {
  cleanupSharedRepo,
  createSharedRepo,
  getSharedEnv,
  getSharedRepoPath,
} from "../ipc/sendMessageTestHelpers";
import { generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "../../src/node/git";

import { installDom } from "./dom";
import { renderApp } from "./renderReviewPanel";
import { cleanupView } from "./helpers";
import { ChatHarness } from "./harness";

import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey, getPendingScopeId, getProjectScopeId } from "@/common/constants/storage";
import { MODEL_ABBREVIATIONS } from "@/common/constants/knownModels";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

type CreationView = {
  env: ReturnType<typeof getSharedEnv>;
  projectPath: string;
  workspaceId: string;
  view: ReturnType<typeof renderApp>;
  cleanupDom: () => void;
  chat: ChatHarness;
};

async function setupCreationView(): Promise<CreationView> {
  const env = getSharedEnv();
  const projectPath = getSharedRepoPath();
  const branchName = generateBranchName("creation-commands");
  const trunkBranch = await detectDefaultTrunkBranch(projectPath);

  const createResult = await env.orpc.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
  });
  if (!createResult.success) {
    throw new Error(createResult.error);
  }

  const metadata = createResult.metadata;
  const workspaceId = metadata.id;
  if (!workspaceId) {
    throw new Error("Workspace ID not returned from creation");
  }

  await env.orpc.workspace.archive({ workspaceId });

  const cleanupDom = installDom();
  // Disable tutorial to prevent it from blocking UI interactions
  globalThis.localStorage.setItem(
    "tutorialState",
    JSON.stringify({ disabled: true, completed: {} })
  );

  const view = renderApp({ apiClient: env.orpc, metadata });

  await view.waitForReady();

  const projectRow = await waitFor(
    () => {
      const el = view.container.querySelector(`[data-project-path="${projectPath}"]`);
      if (!el) throw new Error("Project not found in sidebar");
      return el as HTMLElement;
    },
    { timeout: 10_000 }
  );
  fireEvent.click(projectRow);

  await waitFor(
    () => {
      const textarea = view.container.querySelector(
        'textarea[aria-label="Message Claude"]'
      ) as HTMLTextAreaElement | null;
      if (!textarea) throw new Error("Creation textarea not found");
    },
    { timeout: 5_000 }
  );

  const pendingScopeId = getPendingScopeId(projectPath);
  const chat = new ChatHarness(view.container, pendingScopeId);

  return {
    env,
    projectPath,
    workspaceId,
    view,
    cleanupDom,
    chat,
  };
}

describeIntegration("Creation slash commands", () => {
  beforeAll(async () => {
    await createSharedRepo();
  });

  afterAll(async () => {
    await cleanupSharedRepo();
  });

  test("/model updates project-scoped model in creation mode", async () => {
    const { env, projectPath, workspaceId, view, cleanupDom, chat } = await setupCreationView();

    try {
      const alias = "sonnet";
      const expectedModel = MODEL_ABBREVIATIONS[alias];
      if (!expectedModel) {
        throw new Error(`Missing model abbreviation for ${alias}`);
      }

      await chat.send(`/model ${alias}`);

      await waitFor(
        () => {
          expect(view.container.textContent ?? "").toContain(`Model changed to ${expectedModel}`);
        },
        { timeout: 5_000 }
      );

      const modelKey = getModelKey(getProjectScopeId(projectPath));
      await waitFor(
        () => {
          expect(readPersistedState(modelKey, "")).toBe(expectedModel);
        },
        { timeout: 5_000 }
      );

      await chat.expectInputValue("");
    } finally {
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);

  test("workspace-only commands show a toast and keep input", async () => {
    const { env, projectPath, workspaceId, view, cleanupDom, chat } = await setupCreationView();

    try {
      const command = "/compact";
      await chat.send(command);

      await waitFor(
        () => {
          expect(view.container.textContent ?? "").toContain(
            "Command not available during workspace creation"
          );
        },
        { timeout: 5_000 }
      );

      await chat.expectInputValue(command);
    } finally {
      await env.orpc.workspace.remove({ workspaceId, options: { force: true } }).catch(() => {});
      await cleanupView(view, cleanupDom);
    }
  }, 30_000);
});
