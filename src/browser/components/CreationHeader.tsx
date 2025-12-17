import React from "react";
import { PanelLeft } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { Button } from "@/browser/components/ui/button";

interface CreationHeaderProps {
  projectName?: string;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

/**
 * Minimal header for the workspace creation screen and welcome screen.
 * Shows a sidebar toggle button that's especially important on mobile
 * where the hamburger menu might not be visible (non-touch devices at narrow widths).
 */
export const CreationHeader: React.FC<CreationHeaderProps> = ({
  projectName,
  onToggleSidebar,
  sidebarCollapsed,
}) => {
  return (
    <div
      data-testid="creation-header"
      className="bg-sidebar border-border-light flex h-8 items-center justify-between border-b px-[15px] [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2 [@media(max-width:768px)]:pl-[60px]"
    >
      <div className="text-foreground flex min-w-0 items-center gap-2.5 overflow-hidden font-semibold">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleSidebar}
              className="text-muted hover:text-foreground h-6 w-6 shrink-0"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            {sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} (
            {formatKeybind(KEYBINDS.TOGGLE_SIDEBAR)})
          </TooltipContent>
        </Tooltip>
        {projectName && <span className="min-w-0 truncate font-mono text-xs">{projectName}</span>}
        {!projectName && <span className="text-muted text-xs">New workspace</span>}
      </div>
    </div>
  );
};
