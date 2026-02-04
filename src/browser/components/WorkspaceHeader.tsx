import React, { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, Menu, Pencil, Server } from "lucide-react";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";

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
import { useTutorial } from "@/browser/contexts/TutorialContext";
import type { TerminalSessionCreateOptions } from "@/browser/utils/terminal";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import {
  getTitlebarRightInset,
  isDesktopMode,
  DESKTOP_TITLEBAR_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";
import { DebugLlmRequestModal } from "./DebugLlmRequestModal";
import { WorkspaceLinks } from "./WorkspaceLinks";
import { SkillIndicator } from "./SkillIndicator";
import { useAPI } from "@/browser/contexts/API";
import { useAgent } from "@/browser/contexts/AgentContext";
import type { AgentSkillDescriptor, AgentSkillIssue } from "@/common/types/agentSkill";

interface WorkspaceHeaderProps {
  workspaceId: string;
  projectName: string;
  projectPath: string;
  workspaceName: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  /** Callback to open integrated terminal in sidebar (optional, falls back to popout) */
  onOpenTerminal?: (options?: TerminalSessionCreateOptions) => void;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({
  workspaceId,
  projectName,
  projectPath,
  workspaceName,
  namedWorkspacePath,
  runtimeConfig,
  leftSidebarCollapsed,
  onToggleLeftSidebarCollapsed,
  onOpenTerminal,
}) => {
  const { api } = useAPI();
  const { disableWorkspaceAgents } = useAgent();
  const openTerminalPopout = useOpenTerminal();
  const openInEditor = useOpenInEditor();
  const gitStatus = useGitStatus(workspaceId);
  const { canInterrupt, isStarting, awaitingUserQuestion, loadedSkills } =
    useWorkspaceSidebarState(workspaceId);
  const isWorking = (canInterrupt || isStarting) && !awaitingUserQuestion;
  const { startSequence: startTutorial } = useTutorial();
  const [editorError, setEditorError] = useState<string | null>(null);
  const [debugLlmRequestOpen, setDebugLlmRequestOpen] = useState(false);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [availableSkills, setAvailableSkills] = useState<AgentSkillDescriptor[]>([]);
  const [invalidSkills, setInvalidSkills] = useState<AgentSkillIssue[]>([]);

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
      data-testid="workspace-header"
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
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggleLeftSidebarCollapsed}
            title="Open sidebar"
            aria-label="Open sidebar menu"
            className="mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0"
          >
            <Menu className="h-3.5 w-3.5" />
          </Button>
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
        />
        {editorError && <span className="text-danger-soft text-xs">{editorError}</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMcpModalOpen(true)}
              className="text-muted hover:text-foreground h-6 w-6 shrink-0"
              data-testid="workspace-mcp-button"
            >
              <Server className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            Configure MCP servers for this workspace
          </TooltipContent>
        </Tooltip>
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
    </div>
  );
};
