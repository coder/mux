import React, { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Ellipsis, Menu, Pencil } from "lucide-react";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";

import {
  RIGHT_SIDEBAR_COLLAPSED_KEY,
  getNotifyOnResponseKey,
  getNotifyOnResponseAutoEnableKey,
} from "@/common/constants/storage";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { RuntimeBadge } from "./RuntimeBadge";
import { BranchSelector } from "./BranchSelector";
import { WorkspaceMCPModal } from "./WorkspaceMCPModal";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { Checkbox } from "./ui/checkbox";
import { formatKeybind, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { Button } from "@/browser/components/ui/button";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useLinkSharingEnabled } from "@/browser/contexts/TelemetryEnabledContext";
import { useTutorial } from "@/browser/contexts/TutorialContext";

import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import {
  getTitlebarRightInset,
  isDesktopMode,
  DESKTOP_TITLEBAR_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";
import { DebugLlmRequestModal } from "./DebugLlmRequestModal";
import { WorkspaceLinks } from "./WorkspaceLinks";
import { ShareTranscriptDialog } from "./ShareTranscriptDialog";
import { ConfirmationModal } from "./ConfirmationModal";
import { PopoverError } from "./PopoverError";
import { WorkspaceActionsMenuContent } from "./WorkspaceActionsMenuContent";

import { SkillIndicator } from "./SkillIndicator";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";

import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";
import { forkWorkspace } from "@/browser/utils/chatCommands";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";

interface WorkspaceMenuBarProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  workspaceTitle?: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  /** Callback to open integrated terminal in sidebar (optional, falls back to popout) */
  onOpenTerminal?: (options?: TerminalSessionCreateOptions) => void;
}

export const WorkspaceMenuBar: React.FC<WorkspaceMenuBarProps> = ({
  workspaceId,
  projectName,
  projectPath,
  workspaceName,
  workspaceTitle,
  namedWorkspacePath,
  runtimeConfig,
  leftSidebarCollapsed,
  onToggleLeftSidebarCollapsed,
  onOpenTerminal,
}) => {
  const { api } = useAPI();
  const { disableWorkspaceAgents } = useAgent();
  const { archiveWorkspace } = useWorkspaceActions();
  const isMuxHelpChat = workspaceId === MUX_HELP_CHAT_WORKSPACE_ID;
  const linkSharingEnabled = useLinkSharingEnabled();
  const openTerminalPopout = useOpenTerminal();
  const openInEditor = useOpenInEditor();
  const gitStatus = useGitStatus(workspaceId);
  const { canInterrupt, isStarting, awaitingUserQuestion, loadedSkills, skillLoadErrors } =
    useWorkspaceSidebarState(workspaceId);
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;
  const { startSequence: startTutorial } = useTutorial();
  const [editorError, setEditorError] = useState<string | null>(null);
  const [debugLlmRequestOpen, setDebugLlmRequestOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [shareTranscriptOpen, setShareTranscriptOpen] = useState(false);
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const archiveError = usePopoverError();
  const forkError = usePopoverError();

  const [rightSidebarCollapsed] = usePersistedState<boolean>(RIGHT_SIDEBAR_COLLAPSED_KEY, false, {
    // This state is toggled from RightSidebar, so we need cross-component updates.
    listener: true,
  });

  // Notification on response toggle (workspace-level) - defaults to disabled
  const [notifyOnResponse, setNotifyOnResponse] = usePersistedState<boolean>(
    getNotifyOnResponseKey(workspaceId),
    false
  );

  // Auto-enable notifications for new workspaces (project-level)
  const [autoEnableNotifications, setAutoEnableNotifications] = usePersistedState<boolean>(
    getNotifyOnResponseAutoEnableKey(projectPath),
    false
  );

  // Popover state for notification settings (interactive on click)
  const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);

  const handleOpenTerminal = useCallback(() => {
    // On mobile touch devices, always use popout since the right sidebar is hidden
    const isMobileTouch = window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;
    if (onOpenTerminal && !isMobileTouch) {
      onOpenTerminal();
    } else {
      // Fallback to popout if no integrated terminal callback provided or on mobile
      void openTerminalPopout(workspaceId, runtimeConfig);
    }
  }, [workspaceId, openTerminalPopout, runtimeConfig, onOpenTerminal]);

  const handleOpenInEditor = useCallback(async () => {
    setEditorError(null);
    const result = await openInEditor(workspaceId, namedWorkspacePath, runtimeConfig);
    if (!result.success && result.error) {
      setEditorError(result.error);
      // Clear error after 3 seconds
      setTimeout(() => setEditorError(null), 3000);
    }
  }, [workspaceId, namedWorkspacePath, openInEditor, runtimeConfig]);

  // Mirror sidebar archive behavior so the workspace menu bar matches existing actions.
  // Guards with isArchiving to prevent duplicate calls on slow API paths.
  const handleArchiveChat = useCallback(
    async (anchorEl?: HTMLElement) => {
      if (isArchiving) return;
      setIsArchiving(true);
      try {
        const res = await archiveWorkspace(workspaceId);
        if (!res.success) {
          const rect = anchorEl?.getBoundingClientRect();
          archiveError.showError(
            workspaceId,
            res.error ?? "Failed to archive chat",
            rect ? { top: rect.top + window.scrollY, left: rect.right + 10 } : undefined
          );
        }
      } finally {
        setIsArchiving(false);
      }
    },
    [workspaceId, archiveWorkspace, archiveError, isArchiving]
  );

  const handleForkChat = useCallback(
    async (anchorEl: HTMLElement) => {
      if (!api) {
        const rect = anchorEl.getBoundingClientRect();
        forkError.showError(workspaceId, "Not connected to server", {
          top: rect.top + window.scrollY,
          left: rect.right + 10,
        });
        return;
      }

      const rect = anchorEl.getBoundingClientRect();
      const anchor = { top: rect.top + window.scrollY, left: rect.right + 10 };

      try {
        const result = await forkWorkspace({
          client: api,
          sourceWorkspaceId: workspaceId,
        });
        if (!result.success) {
          forkError.showError(workspaceId, result.error ?? "Failed to fork chat", anchor);
        }
      } catch (error) {
        const message = getErrorMessage(error);
        forkError.showError(workspaceId, message, anchor);
      }
    },
    [api, forkError, workspaceId]
  );

  // Start workspace tutorial on first entry
  useEffect(() => {
    // Small delay to ensure UI is rendered
    const timer = setTimeout(() => {
      startTutorial("workspace");
    }, 300);
    return () => clearTimeout(timer);
  }, [startTutorial]);

  // Listen for /debug-llm-request command to open modal
  useEffect(() => {
    const handler = () => setDebugLlmRequestOpen(true);
    window.addEventListener(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST, handler);
    return () => window.removeEventListener(CUSTOM_EVENTS.OPEN_DEBUG_LLM_REQUEST, handler);
  }, []);

  // Keybind for toggling notifications
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_NOTIFICATIONS)) {
        e.preventDefault();
        setNotifyOnResponse((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [setNotifyOnResponse]);

  // Keybind for opening MCP configuration
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.CONFIGURE_MCP)) {
        e.preventDefault();
        setMcpModalOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Keybind for sharing transcript — lives here (not WorkspaceListItem) so it
  // works even when the left sidebar is collapsed and list items are unmounted.
  useEffect(() => {
    if (isMuxHelpChat || linkSharingEnabled !== true) return;

    const handler = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.SHARE_TRANSCRIPT)) {
        e.preventDefault();
        setShareTranscriptOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isMuxHelpChat, linkSharingEnabled]);

  // Fetch available skills + diagnostics for this workspace
  useEffect(() => {
    if (!api) {
      setAvailableSkills([]);
      setInvalidSkills([]);
      return;
    }

    let isMounted = true;

    const loadSkills = async () => {
      try {
        const diagnostics = await api.agentSkills.listDiagnostics({
          workspaceId,
          disableWorkspaceAgents: disableWorkspaceAgents || undefined,
        });
        if (!isMounted) return;
        setAvailableSkills(Array.isArray(diagnostics.skills) ? diagnostics.skills : []);
        setInvalidSkills(Array.isArray(diagnostics.invalidSkills) ? diagnostics.invalidSkills : []);
      } catch (error) {
        console.error("Failed to load available skills:", error);
        if (isMounted) {
          setAvailableSkills([]);
          setInvalidSkills([]);
        }
      }
    };

    void loadSkills();

    return () => {
      isMounted = false;
    };
  }, [api, workspaceId, disableWorkspaceAgents]);

  // On Windows/Linux, the native window controls overlay the top-right of the app.
  // When the right sidebar is collapsed (20px), this header stretches underneath
  // those controls and the MCP/editor/terminal buttons become unclickable.
  const titlebarRightInset = getTitlebarRightInset();
  const headerRightPadding =
    rightSidebarCollapsed && titlebarRightInset > 0 ? Math.max(0, titlebarRightInset - 20) : 0;
  const isDesktop = isDesktopMode();

  return (
    <div
      style={headerRightPadding > 0 ? { paddingRight: headerRightPadding } : undefined}
      data-testid="workspace-menu-bar"
      className={cn(
        "bg-sidebar border-border-light flex items-center justify-between border-b px-2",
        isDesktop ? DESKTOP_TITLEBAR_HEIGHT_CLASS : "h-8",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag",
        // Keep header visible when iOS keyboard opens and causes scroll
        "mobile-sticky-header"
      )}
    >
      <div
        className={cn(
          "text-foreground flex min-w-0 items-center gap-2.5 overflow-hidden font-semibold",
          isDesktop && "titlebar-no-drag"
        )}
      >
        {leftSidebarCollapsed && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleLeftSidebarCollapsed}
                aria-label="Open sidebar menu"
                className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0"
              >
                <Menu className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Open sidebar ({formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})</TooltipContent>
          </Tooltip>
        )}
        <RuntimeBadge
          runtimeConfig={runtimeConfig}
          isWorking={isWorking}
          workspacePath={namedWorkspacePath}
          workspaceName={workspaceName}
          tooltipSide="bottom"
        />
        <span className="min-w-0 truncate font-mono text-xs">{projectName}</span>
        <div className="flex items-center gap-1">
          <BranchSelector workspaceId={workspaceId} workspaceName={workspaceName} />
          <GitStatusIndicator
            gitStatus={gitStatus}
            workspaceId={workspaceId}
            projectPath={projectPath}
            tooltipPosition="bottom"
            isWorking={isWorking}
          />
        </div>
      </div>
      <div className={cn("flex items-center gap-2", isDesktop && "titlebar-no-drag")}>
        <WorkspaceLinks workspaceId={workspaceId} />
        <Popover open={notificationPopoverOpen} onOpenChange={setNotificationPopoverOpen}>
          <Tooltip {...(notificationPopoverOpen ? { open: false } : {})}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  onClick={() => setNotifyOnResponse((prev) => !prev)}
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded",
                    notifyOnResponse
                      ? "text-foreground"
                      : "text-muted hover:bg-sidebar-hover hover:text-foreground"
                  )}
                  data-testid="notify-on-response-button"
                  aria-pressed={notifyOnResponse}
                >
                  {notifyOnResponse ? (
                    <Bell className="h-3.5 w-3.5" />
                  ) : (
                    <BellOff className="h-3.5 w-3.5" />
                  )}
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              <div className="flex flex-col gap-2">
                <label className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    checked={notifyOnResponse}
                    onCheckedChange={(checked) => setNotifyOnResponse(checked === true)}
                  />
                  <span className="text-foreground">
                    Notify on all responses{" "}
                    <span className="text-muted-foreground">
                      ({formatKeybind(KEYBINDS.TOGGLE_NOTIFICATIONS)})
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2">
                  <Checkbox
                    checked={autoEnableNotifications}
                    onCheckedChange={(checked) => setAutoEnableNotifications(checked === true)}
                  />
                  <span className="text-muted-foreground">
                    Auto-enable for new workspaces in this project
                  </span>
                </label>
                <p className="text-muted-foreground border-separator-light border-t pt-2">
                  Agents can also notify on specific events.{" "}
                  <a
                    href="https://mux.coder.com/config/notifications"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Learn more
                  </a>
                </p>
              </div>
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="bottom"
            align="end"
            className="bg-modal-bg border-separator-light w-64 overflow-visible rounded px-[10px] py-[6px] text-[11px] font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
          >
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  checked={notifyOnResponse}
                  onCheckedChange={(checked) => setNotifyOnResponse(checked === true)}
                />
                <span className="text-foreground">
                  Notify on all responses{" "}
                  <span className="text-muted-foreground">
                    ({formatKeybind(KEYBINDS.TOGGLE_NOTIFICATIONS)})
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  checked={autoEnableNotifications}
                  onCheckedChange={(checked) => setAutoEnableNotifications(checked === true)}
                />
                <span className="text-muted-foreground">
                  Auto-enable for new workspaces in this project
                </span>
              </label>
              <p className="text-muted-foreground border-separator-light border-t pt-2">
                Agents can also notify on specific events.{" "}
                <a
                  href="https://mux.coder.com/config/notifications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
          </PopoverContent>
        </Popover>
        <SkillIndicator
          loadedSkills={loadedSkills}
          availableSkills={availableSkills}
          invalidSkills={invalidSkills}
          skillLoadErrors={skillLoadErrors}
        />
        {editorError && <span className="text-danger-soft text-xs">{editorError}</span>}
        <div className="max-[480px]:hidden">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleOpenInEditor()}
                className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center">
              Open in editor ({formatKeybind(KEYBINDS.OPEN_IN_EDITOR)})
            </TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleOpenTerminal}
              className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0 [&_svg]:h-4 [&_svg]:w-4"
              data-tutorial="terminal-button"
            >
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0114.25 15H1.75A1.75 1.75 0 010 13.25V2.75zm1.75-.25a.25.25 0 00-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 00.25-.25V2.75a.25.25 0 00-.25-.25H1.75zM7.25 8a.75.75 0 01-.22.53l-2.25 2.25a.75.75 0 01-1.06-1.06L5.44 8 3.72 6.28a.75.75 0 111.06-1.06l2.25 2.25c.141.14.22.331.22.53zm1.5 1.5a.75.75 0 000 1.5h3a.75.75 0 000-1.5h-3z" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            New terminal ({formatKeybind(KEYBINDS.OPEN_TERMINAL)})
          </TooltipContent>
        </Tooltip>
        {/* Mirror sidebar share/archive actions in the workspace menu bar for quick access. */}
        <Popover open={moreMenuOpen} onOpenChange={setMoreMenuOpen}>
          <Tooltip {...(moreMenuOpen ? { open: false } : {})}>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted hover:text-foreground ml-1 h-6 w-6 shrink-0"
                  aria-label="Workspace actions"
                  data-testid="workspace-more-actions"
                >
                  <Ellipsis className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="end">
              More actions
            </TooltipContent>
          </Tooltip>

          <PopoverContent
            side="bottom"
            align="end"
            sideOffset={6}
            className="w-[240px] !min-w-0 p-1"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Keep MCP configuration in the more actions menu to keep the workspace menu bar lean. */}
            <WorkspaceActionsMenuContent
              onConfigureMcp={() => setMcpModalOpen(true)}
              onForkChat={(anchorEl) => {
                void handleForkChat(anchorEl);
              }}
              onShareTranscript={() => setShareTranscriptOpen(true)}
              onArchiveChat={(anchorEl) => {
                if (isWorking) {
                  setArchiveConfirmOpen(true);
                } else {
                  // isArchiving guard inside handleArchiveChat prevents duplicate calls.
                  void handleArchiveChat(anchorEl);
                }
              }}
              onCloseMenu={() => setMoreMenuOpen(false)}
              linkSharingEnabled={linkSharingEnabled === true}
              isMuxHelpChat={isMuxHelpChat}
              shortcutClassName="mobile-hide-shortcut-hints"
              configureMcpTestId="workspace-mcp-button"
            />
          </PopoverContent>
        </Popover>
      </div>
      <WorkspaceMCPModal
        workspaceId={workspaceId}
        projectPath={projectPath}
        open={mcpModalOpen}
        onOpenChange={setMcpModalOpen}
      />
      <DebugLlmRequestModal
        workspaceId={workspaceId}
        open={debugLlmRequestOpen}
        onOpenChange={setDebugLlmRequestOpen}
      />
      {linkSharingEnabled === true && !isMuxHelpChat && (
        <ShareTranscriptDialog
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          workspaceTitle={workspaceTitle}
          open={shareTranscriptOpen}
          onOpenChange={setShareTranscriptOpen}
        />
      )}
      {/* Confirm archives that would interrupt an active stream. */}
      <ConfirmationModal
        isOpen={archiveConfirmOpen}
        title={workspaceTitle ? `Archive "${workspaceTitle}" while streaming?` : "Archive chat?"}
        description="This workspace is currently streaming a response."
        warning="Archiving will interrupt the active stream."
        confirmLabel="Archive"
        onConfirm={() => {
          setArchiveConfirmOpen(false);
          // isArchiving guard inside handleArchiveChat prevents duplicate calls.
          void handleArchiveChat();
        }}
        onCancel={() => setArchiveConfirmOpen(false)}
      />
      <PopoverError
        error={forkError.error}
        prefix="Failed to fork chat"
        onDismiss={forkError.clearError}
      />
      <PopoverError
        error={archiveError.error}
        prefix="Failed to archive chat"
        onDismiss={archiveError.clearError}
      />
    </div>
  );
};
