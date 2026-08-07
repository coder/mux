import { FolderKanban, Menu } from "lucide-react";

import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { cn } from "@/common/lib/utils";

interface ProjectChatHeaderProps {
  projectName: string;
  projectPath: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

/** Project Chat intentionally exposes project identity without workspace/worktree actions. */
export function ProjectChatHeader(props: ProjectChatHeaderProps) {
  return (
    <div
      className={cn(
        "bg-sidebar border-border-light mobile-sticky-header flex shrink-0 items-center gap-2 border-b px-2",
        isDesktopMode() ? "h-10 titlebar-drag" : "h-8",
        "[@media(max-width:768px)]:h-11 [@media(max-width:768px)]:px-2"
      )}
      data-testid="project-chat-header"
    >
      {props.leftSidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onToggleLeftSidebarCollapsed}
          aria-label="Open sidebar menu"
          className={cn(
            "h-7 w-7 shrink-0 text-muted hover:text-foreground",
            isDesktopMode() && "titlebar-no-drag"
          )}
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}

      <FolderKanban className="text-content-secondary h-4 w-4 shrink-0" aria-hidden="true" />
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="text-content-primary min-w-0 flex-1 truncate text-sm font-medium">
            {props.projectName}
          </div>
        </TooltipTrigger>
        <TooltipContent align="start">{props.projectPath}</TooltipContent>
      </Tooltip>
      <div className="border-border-medium bg-background-secondary text-content-secondary shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium">
        Orchestrator
      </div>
    </div>
  );
}
