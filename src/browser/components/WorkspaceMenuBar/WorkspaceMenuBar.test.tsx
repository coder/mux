import "../../../../tests/ui/dom";

import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import * as APIModule from "@/browser/contexts/API";
import * as AgentContextModule from "@/browser/contexts/AgentContext";
import * as WorkspaceContextModule from "@/browser/contexts/WorkspaceContext";
import * as WorkspaceStoreModule from "@/browser/stores/WorkspaceStore";
import * as GitStatusStoreModule from "@/browser/stores/GitStatusStore";
import * as RuntimeStatusStoreModule from "@/browser/stores/RuntimeStatusStore";
import * as OpenTerminalModule from "@/browser/hooks/useOpenTerminal";
import * as OpenInEditorModule from "@/browser/hooks/useOpenInEditor";
import * as PersistedStateModule from "@/browser/hooks/usePersistedState";
import * as PopoverErrorHookModule from "@/browser/hooks/usePopoverError";
import * as DesktopTitlebarModule from "@/browser/hooks/useDesktopTitlebar";
import * as TelemetryEnabledContextModule from "@/browser/contexts/TelemetryEnabledContext";
import * as TutorialContextModule from "@/browser/contexts/TutorialContext";
import * as ChatCommandsModule from "@/browser/utils/chatCommands";
import * as GitStatusIndicatorModule from "../GitStatusIndicator/GitStatusIndicator";
import * as MultiProjectGitStatusIndicatorModule from "../GitStatusIndicator/MultiProjectGitStatusIndicator";
import * as RuntimeBadgeModule from "../RuntimeBadge/RuntimeBadge";
import * as BranchSelectorModule from "../BranchSelector/BranchSelector";
import * as WorkspaceMCPModalModule from "../WorkspaceMCPModal/WorkspaceMCPModal";
import * as TooltipModule from "../Tooltip/Tooltip";
import * as PopoverModule from "../Popover/Popover";
import * as CheckboxModule from "../Checkbox/Checkbox";
import * as DebugLlmRequestModalModule from "../DebugLlmRequestModal/DebugLlmRequestModal";
import * as WorkspaceLinksModule from "../WorkspaceLinks/WorkspaceLinks";
import * as ShareTranscriptDialogModule from "../ShareTranscriptDialog/ShareTranscriptDialog";
import * as ConfirmationModalModule from "../ConfirmationModal/ConfirmationModal";
import * as PopoverErrorModule from "../PopoverError/PopoverError";
import * as WorkspaceActionsMenuContentModule from "../WorkspaceActionsMenuContent/WorkspaceActionsMenuContent";
import * as WorkspaceTerminalIconModule from "../icons/WorkspaceTerminalIcon/WorkspaceTerminalIcon";
import * as SkillIndicatorModule from "../SkillIndicator/SkillIndicator";

import { WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX } from "@/constants/layout";
import { WorkspaceMenuBar } from "./WorkspaceMenuBar";

let cleanupDom: (() => void) | null = null;
const workspaceId = "workspace-1";

function TestWrapper(props: PropsWithChildren) {
  return <>{props.children}</>;
}

function resolveArchivePreflight(
  result: { kind: "ready" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "ready",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

function resolveArchiveResult(
  result: { kind: "archived" } | { kind: "confirm-lossy-untracked-files"; paths: string[] } = {
    kind: "archived",
  }
) {
  return Promise.resolve({ success: true as const, data: result });
}

type ArchiveConfirmationResult =
  | { kind: "archived" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
type ArchivePreflightConfirmationResult =
  | { kind: "ready" }
  | { kind: "confirm-lossy-untracked-files"; paths: string[] };
interface ArchiveWorkspaceActionResult {
  success: boolean;
  error?: string;
  data?: ArchiveConfirmationResult;
}
interface ArchivePreflightActionResult {
  success: boolean;
  error?: string;
  data?: ArchivePreflightConfirmationResult;
}

let preflightArchiveWorkspaceMock = mock(
  (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
);
let archiveWorkspaceMock = mock(
  (
    _workspaceId: string,
    _options?: { acknowledgedUntrackedPaths?: string[] }
  ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
);
let archiveShowErrorMock = mock(() => undefined);

function installWorkspaceMenuBarTestDoubles() {
  preflightArchiveWorkspaceMock = mock(
    (_workspaceId: string): Promise<ArchivePreflightActionResult> => resolveArchivePreflight()
  );
  archiveWorkspaceMock = mock(
    (
      _workspaceId: string,
      _options?: { acknowledgedUntrackedPaths?: string[] }
    ): Promise<ArchiveWorkspaceActionResult> => resolveArchiveResult()
  );
  archiveShowErrorMock = mock(() => undefined);

  spyOn(APIModule, "useAPI").mockImplementation(
    () => ({ api: null }) as unknown as ReturnType<typeof APIModule.useAPI>
  );
  spyOn(AgentContextModule, "useAgent").mockImplementation(
    () =>
      ({ disableWorkspaceAgents: false }) as unknown as ReturnType<
        typeof AgentContextModule.useAgent
      >
  );
  spyOn(WorkspaceContextModule, "useWorkspaceActions").mockImplementation(
    () =>
      ({
        preflightArchiveWorkspace: preflightArchiveWorkspaceMock,
        archiveWorkspace: archiveWorkspaceMock,
      }) as unknown as ReturnType<typeof WorkspaceContextModule.useWorkspaceActions>
  );
  spyOn(WorkspaceContextModule, "useWorkspaceContext").mockImplementation(
    () =>
      ({ workspaceMetadata: new Map() }) as unknown as ReturnType<
        typeof WorkspaceContextModule.useWorkspaceContext
      >
  );
  spyOn(WorkspaceStoreModule, "useWorkspaceSidebarState").mockImplementation(
    () =>
      ({
        canInterrupt: false,
        isStarting: false,
        awaitingUserQuestion: false,
        loadedSkills: [],
        skillLoadErrors: [],
      }) as unknown as ReturnType<typeof WorkspaceStoreModule.useWorkspaceSidebarState>
  );
  spyOn(GitStatusStoreModule, "useGitStatus").mockImplementation(() => null);
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatus").mockImplementation(() => "unsupported");
  spyOn(RuntimeStatusStoreModule, "useRuntimeStatusStoreRaw").mockImplementation(
    () =>
      ({ invalidateWorkspace: () => undefined }) as unknown as ReturnType<
        typeof RuntimeStatusStoreModule.useRuntimeStatusStoreRaw
      >
  );
  spyOn(OpenTerminalModule, "useOpenTerminal").mockImplementation(() =>
    mock(() => Promise.resolve())
  );
  spyOn(OpenInEditorModule, "useOpenInEditor").mockImplementation(() =>
    mock(() => Promise.resolve({ success: true }))
  );
  spyOn(PersistedStateModule, "usePersistedState").mockImplementation(
    <T,>(_key: string, defaultValue: T) => [defaultValue, mock(() => undefined)] as const
  );
  spyOn(PopoverErrorHookModule, "usePopoverError").mockImplementation(
    () =>
      ({
        error: null,
        showError: archiveShowErrorMock,
        clearError: () => undefined,
      }) as unknown as ReturnType<typeof PopoverErrorHookModule.usePopoverError>
  );
  spyOn(DesktopTitlebarModule, "isDesktopMode").mockImplementation(() => false);
  spyOn(TelemetryEnabledContextModule, "useLinkSharingEnabled").mockImplementation(() => false);
  spyOn(TutorialContextModule, "useTutorial").mockImplementation(
    () =>
      ({ startSequence: () => undefined }) as unknown as ReturnType<
        typeof TutorialContextModule.useTutorial
      >
  );
  spyOn(ChatCommandsModule, "forkWorkspace").mockImplementation(() =>
    Promise.resolve({ success: true as const })
  );

  spyOn(GitStatusIndicatorModule, "GitStatusIndicator").mockImplementation(
    (() => null) as unknown as typeof GitStatusIndicatorModule.GitStatusIndicator
  );
  spyOn(MultiProjectGitStatusIndicatorModule, "MultiProjectGitStatusIndicator").mockImplementation(
    (() =>
      null) as unknown as typeof MultiProjectGitStatusIndicatorModule.MultiProjectGitStatusIndicator
  );
  spyOn(RuntimeBadgeModule, "RuntimeBadge").mockImplementation(
    (() => null) as unknown as typeof RuntimeBadgeModule.RuntimeBadge
  );
  spyOn(BranchSelectorModule, "BranchSelector").mockImplementation(
    (() => null) as unknown as typeof BranchSelectorModule.BranchSelector
  );
  spyOn(WorkspaceMCPModalModule, "WorkspaceMCPModal").mockImplementation(
    (() => null) as unknown as typeof WorkspaceMCPModalModule.WorkspaceMCPModal
  );
  spyOn(TooltipModule, "Tooltip").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.Tooltip
  );
  spyOn(TooltipModule, "TooltipTrigger").mockImplementation(
    TestWrapper as unknown as typeof TooltipModule.TooltipTrigger
  );
  spyOn(TooltipModule, "TooltipContent").mockImplementation(
    (() => null) as unknown as typeof TooltipModule.TooltipContent
  );
  spyOn(PopoverModule, "Popover").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.Popover
  );
  spyOn(PopoverModule, "PopoverTrigger").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverTrigger
  );
  spyOn(PopoverModule, "PopoverContent").mockImplementation(
    TestWrapper as unknown as typeof PopoverModule.PopoverContent
  );
  spyOn(CheckboxModule, "Checkbox").mockImplementation(
    (() => null) as unknown as typeof CheckboxModule.Checkbox
  );
  spyOn(DebugLlmRequestModalModule, "DebugLlmRequestModal").mockImplementation(
    (() => null) as unknown as typeof DebugLlmRequestModalModule.DebugLlmRequestModal
  );
  spyOn(WorkspaceLinksModule, "WorkspaceLinks").mockImplementation(
    (() => null) as unknown as typeof WorkspaceLinksModule.WorkspaceLinks
  );
  spyOn(ShareTranscriptDialogModule, "ShareTranscriptDialog").mockImplementation(
    (() => null) as unknown as typeof ShareTranscriptDialogModule.ShareTranscriptDialog
  );
  spyOn(ConfirmationModalModule, "ConfirmationModal").mockImplementation(((props: {
    isOpen: boolean;
    title: string;
    description?: React.ReactNode;
    warning?: React.ReactNode;
    confirmLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
  }) =>
    props.isOpen ? (
      <div data-testid="archive-confirmation-modal">
        <div>{props.title}</div>
        {props.description}
        {props.warning}
        <button type="button" onClick={props.onConfirm}>
          {props.confirmLabel ?? "Confirm"}
        </button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    ) : null) as unknown as typeof ConfirmationModalModule.ConfirmationModal);
  spyOn(PopoverErrorModule, "PopoverError").mockImplementation(
    (() => null) as unknown as typeof PopoverErrorModule.PopoverError
  );
  spyOn(WorkspaceActionsMenuContentModule, "WorkspaceActionsMenuContent").mockImplementation(
    ((props: { onArchiveChat?: ((anchorEl: HTMLElement) => void) | null }) =>
      props.onArchiveChat ? (
        <button type="button" onClick={(event) => props.onArchiveChat?.(event.currentTarget)}>
          Archive chat
        </button>
      ) : null) as unknown as typeof WorkspaceActionsMenuContentModule.WorkspaceActionsMenuContent
  );
  spyOn(WorkspaceTerminalIconModule, "WorkspaceTerminalIcon").mockImplementation(
    (() => null) as unknown as typeof WorkspaceTerminalIconModule.WorkspaceTerminalIcon
  );
  spyOn(SkillIndicatorModule, "SkillIndicator").mockImplementation(
    (() => null) as unknown as typeof SkillIndicatorModule.SkillIndicator
  );
}

const defaultProps: React.ComponentProps<typeof WorkspaceMenuBar> = {
  workspaceId,
  projectName: "demo",
  projectPath: "/projects/demo",
  workspaceName: "feature-branch",
  workspaceTitle: "Feature branch",
  namedWorkspacePath: "/projects/demo/workspaces/feature-branch",
  runtimeConfig: { type: "worktree", srcBaseDir: "/tmp/src" },
  leftSidebarCollapsed: false,
  onToggleLeftSidebarCollapsed: () => undefined,
};

describe("WorkspaceMenuBar archive confirmations", () => {
  beforeEach(() => {
    cleanupDom = installDom();
    installWorkspaceMenuBarTestDoubles();
    if (!window.matchMedia) {
      window.matchMedia = (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: (_listener) => undefined,
        removeListener: (_listener) => undefined,
        addEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | AddEventListenerOptions
        ) => undefined,
        removeEventListener: (
          _type: string,
          _listener: EventListenerOrEventListenerObject | null,
          _options?: boolean | EventListenerOptions
        ) => undefined,
        dispatchEvent: (_event) => false,
      });
    }
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  it("applies the collapsed-left-sidebar inset immediately from props", () => {
    const view = render(<WorkspaceMenuBar {...defaultProps} leftSidebarCollapsed />);

    expect(view.getByTestId("workspace-menu-bar").style.paddingLeft).toBe(
      `${WORKSPACE_MENU_BAR_LEFT_SIDEBAR_COLLAPSED_PADDING_PX}px`
    );
  });

  it("opens the archive confirmation modal when preflight finds untracked files", async () => {
    preflightArchiveWorkspaceMock = mock(
      (_workspaceId: string): Promise<ArchivePreflightActionResult> =>
        resolveArchivePreflight({
          kind: "confirm-lossy-untracked-files",
          paths: [".cache/", "temp.txt"],
        })
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archiveWorkspaceMock).not.toHaveBeenCalled();
    expect(view.getByText("Archive workspace with untracked files?")).toBeTruthy();
  });

  it("reopens the archive confirmation modal when archive finds new untracked files", async () => {
    let archiveAttempt = 0;
    archiveWorkspaceMock = mock(
      (
        id: string,
        options?: { acknowledgedUntrackedPaths?: string[] }
      ): Promise<ArchiveWorkspaceActionResult> => {
        archiveAttempt += 1;
        if (archiveAttempt === 1) {
          return resolveArchiveResult({
            kind: "confirm-lossy-untracked-files",
            paths: ["late-file.txt"],
          });
        }

        expect(id).toBe(workspaceId);
        expect(options).toEqual({ acknowledgedUntrackedPaths: ["late-file.txt"] });
        return resolveArchiveResult({ kind: "archived" });
      }
    );

    const view = render(<WorkspaceMenuBar {...defaultProps} />);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive chat" }));
    });

    await waitFor(() => {
      expect(view.getByTestId("archive-confirmation-modal")).toBeTruthy();
    });
    expect(archiveShowErrorMock).not.toHaveBeenCalled();
    expect(archiveWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(archiveWorkspaceMock).toHaveBeenNthCalledWith(1, workspaceId, undefined);

    act(() => {
      fireEvent.click(view.getByRole("button", { name: "Archive and delete files" }));
    });

    await waitFor(() => {
      expect(archiveWorkspaceMock).toHaveBeenCalledTimes(2);
    });
    expect(archiveWorkspaceMock).toHaveBeenNthCalledWith(2, workspaceId, {
      acknowledgedUntrackedPaths: ["late-file.txt"],
    });
    expect(archiveShowErrorMock).not.toHaveBeenCalled();
  });
});
