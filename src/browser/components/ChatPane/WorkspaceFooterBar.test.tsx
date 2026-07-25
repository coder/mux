import "../../../../tests/ui/dom";

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as ProjectContextModule from "@/browser/contexts/ProjectContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as GitStatusStoreModule from "@/browser/stores/GitStatusStore";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as RuntimeBadgeModule from "../RuntimeBadge/RuntimeBadge";
import * as BranchSelectorModule from "../BranchSelector/BranchSelector";
import * as GitStatusIndicatorModule from "../GitStatusIndicator/GitStatusIndicator";
import * as MultiProjectGitStatusIndicatorModule from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import * as WorkspaceLinksModule from "../WorkspaceLinks/WorkspaceLinks";
import type { WorkspaceFooterBar as WorkspaceFooterBarComponent } from "./WorkspaceFooterBar";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

let WorkspaceFooterBar!: typeof WorkspaceFooterBarComponent;

let workspaceMetadata = new Map<string, FrontendWorkspaceMetadata>();
let cleanupDom: (() => void) | null = null;
const workspaceId = "workspace-1";

function installFooterBarTestDoubles() {
  spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
    () =>
      ({ workspaceMetadata }) as unknown as ReturnType<
        typeof WorkspaceContextModule.useWorkspaceContext
      >
  );
  spyOn(ProjectContextModule, "useProjectContext").mockImplementation(
    () =>
      ({ userProjects: new Map() }) as unknown as ReturnType<
        typeof ProjectContextModule.useProjectContext
      >
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(
    () =>
      ({
        canInterrupt: false,
        isStarting: false,
        awaitingUserQuestion: false,
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceUsage").mockImplementation(
    () =>
      ({ totalTokens: 0 }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceUsage>
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceStreamingStats").mockImplementation(() => null);
  spyOn(GitStatusStoreModule, "useGitStatus").mockImplementation(() => null);
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => "unsupported");

  spyOn(RuntimeBadgeModule, "RuntimeBadge").mockImplementation(
    (() => null) as unknown as typeof RuntimeBadgeModule.RuntimeBadge
  );
  spyOn(BranchSelectorModule, "BranchSelector").mockImplementation(
    (() => null) as unknown as typeof BranchSelectorModule.BranchSelector
  );
  spyOn(GitStatusIndicatorModule, "GitStatusIndicator").mockImplementation(
    (() => null) as unknown as typeof GitStatusIndicatorModule.GitStatusIndicator
  );
  spyOn(MultiProjectGitStatusIndicatorModule, "MultiProjectGitStatusIndicator").mockImplementation(
    (() =>
      null) as unknown as typeof MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
  );
  spyOn(WorkspaceLinksModule, "WorkspaceLinks").mockImplementation(
    (() => null) as unknown as typeof WorkspaceLinksModule.WorkspaceLinks
  );
}

const repoMetadata: FrontendWorkspaceMetadata = {
  id: workspaceId,
  name: "feature-branch",
  projectName: "demo",
  projectPath: "/projects/demo",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("WorkspaceFooterBar repository controls", () => {
  beforeEach(() => {
    workspaceMetadata = new Map();
    cleanupDom = installDom();
    installFooterBarTestDoubles();
    /* eslint-disable @typescript-eslint/no-require-imports */
    ({ WorkspaceFooterBar } = require("./WorkspaceFooterBar?workspace-footer-bar-test=1") as {
      WorkspaceFooterBar: typeof WorkspaceFooterBarComponent;
    });
    /* eslint-enable @typescript-eslint/no-require-imports */
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("hides repository controls for scratch workspaces", () => {
    const scratchPath = "/home/user/.mux/scratch/workspace-1";
    const scratchMetadata: FrontendWorkspaceMetadata = {
      ...repoMetadata,
      kind: "scratch",
      name: "scratch-workspace-1",
      projectName: "Scratch",
      projectPath: scratchPath,
      namedWorkspacePath: scratchPath,
      runtimeConfig: { type: "local" },
    };
    workspaceMetadata.set(workspaceId, scratchMetadata);

    render(
      <WorkspaceFooterBar
        workspaceId={workspaceId}
        projectName="Scratch"
        projectPath={scratchPath}
        workspaceName="scratch-workspace-1"
        namedWorkspacePath={scratchPath}
        runtimeConfig={{ type: "local" }}
      />
    );

    expect(BranchSelectorModule.BranchSelector).not.toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).not.toHaveBeenCalled();
    expect(
      MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
    ).not.toHaveBeenCalled();
  });

  it("shows branch + single-project git status for repo-backed workspaces", () => {
    workspaceMetadata.set(workspaceId, repoMetadata);

    render(
      <WorkspaceFooterBar
        workspaceId={workspaceId}
        projectName="demo"
        projectPath="/projects/demo"
        workspaceName="feature-branch"
        namedWorkspacePath="/projects/demo/workspaces/feature-branch"
        runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
      />
    );

    expect(BranchSelectorModule.BranchSelector).toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).toHaveBeenCalled();
    expect(
      MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
    ).not.toHaveBeenCalled();
  });

  it("uses the multi-project git status indicator for multi-project workspaces", () => {
    const multiProjectMetadata: FrontendWorkspaceMetadata = {
      ...repoMetadata,
      projects: [
        { projectPath: "/projects/demo", projectName: "demo" },
        { projectPath: "/projects/other", projectName: "other" },
      ],
    };
    workspaceMetadata.set(workspaceId, multiProjectMetadata);

    render(
      <WorkspaceFooterBar
        workspaceId={workspaceId}
        projectName="demo"
        projectPath="/projects/demo"
        workspaceName="feature-branch"
        namedWorkspacePath="/projects/demo/workspaces/feature-branch"
        runtimeConfig={{ type: "worktree", srcBaseDir: "/tmp/src" }}
      />
    );

    expect(MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator).toHaveBeenCalled();
    expect(GitStatusIndicatorModule.GitStatusIndicator).not.toHaveBeenCalled();
  });
});
