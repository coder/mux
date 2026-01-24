import { waitFor } from "@testing-library/react";

import {
  createTestEnvironment,
  cleanupTestEnvironment,
  type TestEnvironment,
} from "../../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo, generateBranchName } from "../../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

import { installDom } from "../dom";
import { renderApp, type RenderedApp } from "../renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "../helpers";
import { ChatHarness } from "./chatHarness";

async function waitForWorkspaceChatToRender(container: HTMLElement): Promise<void> {
  await waitFor(
    () => {
      const messageWindow = container.querySelector('[data-testid="message-window"]');
      if (!messageWindow) {
        throw new Error("Workspace chat view not rendered yet");
      }
    },
    { timeout: 30_000 }
  );
}

export interface AppHarness {
  env: TestEnvironment;
  repoPath: string;
  workspaceId: string;
  metadata: FrontendWorkspaceMetadata;
  view: RenderedApp;
  chat: ChatHarness;
  dispose(): Promise<void>;
}

export async function createAppHarness(options?: {
  branchPrefix?: string;
  aiMode?: "mock-router" | "none";
  /**
   * Optional hook to set up DOM-dependent globals (e.g. localStorage) before
   * the App is rendered.
   */
  beforeRender?: () => void;
}): Promise<AppHarness> {
  const repoPath = await createTempGitRepo();
  const env = await createTestEnvironment();

  if (options?.aiMode !== "none") {
    env.services.aiService.enableMockMode();
  }

  let workspaceId: string | undefined;
  let metadata: FrontendWorkspaceMetadata | undefined;
  let view: RenderedApp | undefined;
  let cleanupDom: (() => void) | undefined;

  try {
    const trunkBranch = await detectDefaultTrunkBranch(repoPath);
    const branchName = generateBranchName(options?.branchPrefix ?? "ui");

    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    if (!createResult.success) {
      throw new Error(`Failed to create workspace: ${createResult.error}`);
    }

    workspaceId = createResult.metadata.id;
    metadata = createResult.metadata;

    cleanupDom = installDom();
    options?.beforeRender?.();
    view = renderApp({ apiClient: env.orpc, metadata });

    await setupWorkspaceView(view, metadata, workspaceId);
    await waitForWorkspaceChatToRender(view.container);

    const chat = new ChatHarness(view.container, workspaceId);

    return {
      env,
      repoPath,
      workspaceId,
      metadata,
      view,
      chat,
      async dispose() {
        if (view && cleanupDom) {
          await cleanupView(view, cleanupDom);
        } else if (cleanupDom) {
          cleanupDom();
        }

        if (workspaceId) {
          try {
            await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
          } catch {
            // Best effort.
          }
        }

        await cleanupTestEnvironment(env);
        await cleanupTempGitRepo(repoPath);
      },
    };
  } catch (error) {
    if (cleanupDom) {
      cleanupDom();
    }

    if (workspaceId) {
      try {
        await env.orpc.workspace.remove({ workspaceId, options: { force: true } });
      } catch {
        // Best effort.
      }
    }

    await cleanupTestEnvironment(env);
    await cleanupTempGitRepo(repoPath);

    throw error;
  }
}
