import React, { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { GitStatusIndicator } from "./GitStatusIndicator";
import { RuntimeBadge } from "./RuntimeBadge";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { Button } from "@/browser/components/ui/button";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useTutorial } from "@/browser/contexts/TutorialContext";
import { useOpenTerminal } from "@/browser/hooks/useOpenTerminal";
import { useOpenInEditor } from "@/browser/hooks/useOpenInEditor";

interface WorkspaceHeaderProps {
  workspaceId: string;
  projectName: string;
  branch: string;
  namedWorkspacePath: string;
  runtimeConfig?: RuntimeConfig;
}

export const WorkspaceHeader: React.FC<WorkspaceHeaderProps> = ({
  workspaceId,
  projectName,
  branch,
  namedWorkspacePath,
  runtimeConfig,
}) => {
  const openTerminal = useOpenTerminal();
  const openInEditor = useOpenInEditor();
  const gitStatus = useGitStatus(workspaceId);
  const { canInterrupt } = useWorkspaceSidebarState(workspaceId);
  const { startSequence: startTutorial, isSequenceCompleted } = useTutorial();
  const [editorError, setEditorError] = useState<string | null>(null);

  const handleOpenTerminal = useCallback(() => {
    openTerminal(workspaceId, runtimeConfig);
  }, [workspaceId, openTerminal, runtimeConfig]);

  const handleOpenInEditor = useCallback(async () => {
    setEditorError(null);
    const result = await openInEditor(workspaceId, namedWorkspacePath, runtimeConfig);
    if (!result.success && result.error) {
      setEditorError(result.error);
      // Clear error after 3 seconds
      setTimeout(() => setEditorError(null), 3000);
    }
  }, [workspaceId, namedWorkspacePath, openInEditor, runtimeConfig]);

  // Start workspace tutorial on first entry (only if settings tutorial is done)
  useEffect(() => {
    // Don't show workspace tutorial until settings tutorial is completed
    // This prevents both tutorials from competing on first launch
    if (!isSequenceCompleted("settings")) {
      return;
    }
    // Small delay to ensure UI is rendered
    const timer = setTimeout(() => {
      startTutorial("workspace");
    }, 300);
    return () => clearTimeout(timer);
  }, [startTutorial, isSequenceCompleted]);

  return (
    <div className="bg-sidebar border-border-light flex h-8 items-center justify-between border-b px-[15px] [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:flex-wrap [@media(max-width:768px)]:gap-2 [@media(max-width:768px)]:py-2 [@media(max-width:768px)]:pl-[60px]">
      <div className="text-foreground flex min-w-0 items-center gap-2 overflow-hidden font-semibold">
        <RuntimeBadge runtimeConfig={runtimeConfig} isWorking={canInterrupt} />
        <GitStatusIndicator
          gitStatus={gitStatus}
          workspaceId={workspaceId}
          tooltipPosition="bottom"
          isWorking={canInterrupt}
        />
        <span className="min-w-0 truncate font-mono text-xs">
          {projectName} / {branch}
        </span>
        <span className="text-muted min-w-0 truncate font-mono text-[11px] font-normal">
          {namedWorkspacePath}
        </span>
      </div>
      <div className="flex items-center">
        {editorError && <span className="text-danger-soft mr-2 text-xs">{editorError}</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleOpenInEditor()}
              className="text-muted hover:text-foreground h-6 w-6 shrink-0"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center">
            Open in editor ({formatKeybind(KEYBINDS.OPEN_IN_EDITOR)})
          </TooltipContent>
        </Tooltip>
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
            Open terminal window ({formatKeybind(KEYBINDS.OPEN_TERMINAL)})
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
