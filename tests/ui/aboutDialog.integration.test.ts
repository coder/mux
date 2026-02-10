import "./dom";

import { fireEvent, waitFor, within } from "@testing-library/react";

import { installDom } from "./dom";
import { renderApp, type RenderedApp } from "./renderReviewPanel";
import { cleanupView, setupWorkspaceView } from "./helpers";
import { createTestEnvironment, cleanupTestEnvironment, type TestEnvironment } from "../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo, generateBranchName } from "../ipc/helpers";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { UpdateStatus } from "@/common/orpc/types";

type MutableUpdateService = {
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => void;
  currentStatus: UpdateStatus;
  notifySubscribers: () => void;
};

function getUpdateService(env: TestEnvironment): MutableUpdateService {
  return env.services.updateService as unknown as MutableUpdateService;
}

function setDesktopApiEnabled() {
  window.api = {
    platform: process.platform,
    versions: {},
  };
}

function clearDesktopApi() {
  delete (window as Window & { api?: unknown }).api;
}

function setUpdateStatus(updateService: MutableUpdateService, status: UpdateStatus) {
  updateService.currentStatus = status;
  updateService.notifySubscribers();
}

async function openAboutDialog(view: RenderedApp) {
  const trigger = await waitFor(() => {
    const triggerButton = view.container.querySelector(
      'button[aria-label="Open about dialog"]'
    ) as HTMLButtonElement | null;
    if (!triggerButton) {
      throw new Error("About dialog trigger was not found in the title bar");
    }
    return triggerButton;
  });

  fireEvent.click(trigger);

  const dialog = await waitFor(() => {
    const dialogElement = view.container.ownerDocument.body.querySelector(
      '[role="dialog"]'
    ) as HTMLElement | null;
    if (!dialogElement) {
      throw new Error("About dialog did not open");
    }
    return dialogElement;
  });

  return within(dialog);
}

describe("About dialog (UI)", () => {
  let env: TestEnvironment;
  let repoPath: string;
  let workspaceId: string;
  let workspaceMetadata: FrontendWorkspaceMetadata;
  let cleanupDom: (() => void) | null = null;
  let view: RenderedApp | null = null;

  beforeAll(async () => {
    env = await createTestEnvironment();
    repoPath = await createTempGitRepo();

    const trunkBranch = await detectDefaultTrunkBranch(repoPath);
    const branchName = generateBranchName("about-dialog");
    const createResult = await env.orpc.workspace.create({
      projectPath: repoPath,
      branchName,
      trunkBranch,
    });

    if (!createResult.success) {
      throw new Error(`Failed to create workspace: ${createResult.error}`);
    }

    workspaceId = createResult.metadata.id;
    workspaceMetadata = createResult.metadata;
  }, 60_000);

  beforeEach(async () => {
    clearDesktopApi();
    cleanupDom = installDom();
    view = renderApp({ apiClient: env.orpc, metadata: workspaceMetadata });
    await setupWorkspaceView(view, workspaceMetadata, workspaceId);
  }, 60_000);

  afterEach(async () => {
    clearDesktopApi();
    setUpdateStatus(getUpdateService(env), { type: "idle" });

    if (view && cleanupDom) {
      await cleanupView(view, cleanupDom);
    } else {
      cleanupDom?.();
    }

    view = null;
    cleanupDom = null;
  });

  afterAll(async () => {
    try {
      const removeResult = await env.orpc.workspace.remove({
        workspaceId,
        options: { force: true },
      });

      if (!removeResult.success) {
        console.warn("Failed to remove workspace during cleanup:", removeResult.error);
      }
    } finally {
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(repoPath);
    }
  }, 60_000);

  test("clicking the title bar version opens the About dialog", async () => {
    if (!view) {
      throw new Error("App was not rendered");
    }

    const dialog = await openAboutDialog(view);
    expect(dialog.getByRole("heading", { name: "About" })).toBeTruthy();
  });

  test("Check for Updates button calls api.update.check", async () => {
    if (!view) {
      throw new Error("App was not rendered");
    }

    const updateService = getUpdateService(env);
    const originalCheck = updateService.check;
    const checkSpy = jest.fn(async () => undefined);
    updateService.check = checkSpy as typeof updateService.check;

    try {
      setDesktopApiEnabled();

      const dialog = await openAboutDialog(view);
      const callsBeforeClick = checkSpy.mock.calls.length;
      fireEvent.click(dialog.getByRole("button", { name: "Check for Updates" }));

      await waitFor(() => {
        expect(checkSpy).toHaveBeenCalledTimes(callsBeforeClick + 1);
      });
    } finally {
      updateService.check = originalCheck;
    }
  });

  test("available update status shows Download button that calls api.update.download", async () => {
    if (!view) {
      throw new Error("App was not rendered");
    }

    const updateService = getUpdateService(env);
    const originalDownload = updateService.download;
    const downloadSpy = jest.fn(async () => undefined);
    updateService.download = downloadSpy as typeof updateService.download;

    try {
      setUpdateStatus(updateService, {
        type: "available",
        info: { version: "v9.9.9" },
      });
      setDesktopApiEnabled();

      const dialog = await openAboutDialog(view);
      const downloadButton = await waitFor(() => {
        return dialog.getByRole("button", { name: "Download" });
      });

      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(downloadSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      updateService.download = originalDownload;
    }
  });

  test("downloaded update status shows Install button that calls api.update.install", async () => {
    if (!view) {
      throw new Error("App was not rendered");
    }

    const updateService = getUpdateService(env);
    const originalInstall = updateService.install;
    const installSpy = jest.fn(() => undefined);
    updateService.install = installSpy as typeof updateService.install;

    try {
      setUpdateStatus(updateService, {
        type: "downloaded",
        info: { version: "v9.9.10" },
      });
      setDesktopApiEnabled();

      const dialog = await openAboutDialog(view);
      const installButton = await waitFor(() => {
        return dialog.getByRole("button", { name: "Install & restart" });
      });

      fireEvent.click(installButton);

      await waitFor(() => {
        expect(installSpy).toHaveBeenCalledTimes(1);
      });
    } finally {
      updateService.install = originalInstall;
    }
  });
});
