import React from "react";
import { PanelLeft, PanelRight } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";

interface SidebarCollapseButtonProps {
  collapsed: boolean;
  onToggle: () => void;
  /** Direction the sidebar expands toward (left sidebar expands right, right sidebar expands left) */
  side: "left" | "right";
  /** Optional keyboard shortcut to show in tooltip */
  shortcut?: string;
}

/**
 * Collapse/expand toggle button for sidebars.
 * Icon selection is driven by the sidebar side.
 */
export const SidebarCollapseButton: React.FC<SidebarCollapseButtonProps> = ({
  collapsed,
  onToggle,
  side,
  shortcut,
}) => {
  const label = "Toggle sidebar";
  const Icon = side === "left" ? PanelLeft : PanelRight;

  const className =
    side === "left"
      ? "text-muted hover:bg-hover hover:text-foreground focus-visible:ring-border flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 transition-all duration-200 focus-visible:outline-none focus-visible:ring-1"
      : collapsed
        ? "text-muted hover:bg-hover hover:text-foreground focus-visible:ring-border flex w-full flex-1 cursor-pointer items-center justify-center bg-transparent p-0 transition-all duration-200 focus-visible:outline-none focus-visible:ring-1"
        : "text-muted border-dark hover:bg-hover hover:text-foreground focus-visible:ring-border flex h-6 w-full cursor-pointer items-center justify-center border-t bg-transparent p-0 transition-all duration-200 focus-visible:outline-none focus-visible:ring-1";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button onClick={onToggle} aria-label={label} className={className}>
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent align="center">
        {label}
        {shortcut && ` (${shortcut})`}
      </TooltipContent>
    </Tooltip>
  );
};
