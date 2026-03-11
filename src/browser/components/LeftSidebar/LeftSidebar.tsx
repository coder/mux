import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import ProjectSidebar from "../ProjectSidebar/ProjectSidebar";
import { TitleBar } from "../TitleBar/TitleBar";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface LeftSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  widthPx?: number;
  isResizing?: boolean;
  onStartResize?: (e: React.MouseEvent) => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

export function LeftSidebar(props: LeftSidebarProps) {
  const {
    collapsed,
    onToggleCollapsed,
    widthPx,
    isResizing,
    onStartResize,
    ...projectSidebarProps
  } = props;
  const isDesktop = isDesktopMode();
  // Match the CSS gate for the mobile "overlay" sidebar; we don't show a drag handle in that mode.
  const isMobileTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

  const handleBeforeOpenSettings = () => {
    // Keep settings navigation escapable on touch devices by dismissing the
    // off-canvas sidebar as soon as the user opens settings from this sidebar.
    if (!collapsed && isMobileTouch) {
      onToggleCollapsed();
    }
  };

  const width = collapsed ? "0px" : `${widthPx ?? 288}px`;

  return (
    <>
      {/* Overlay backdrop - only visible on mobile when sidebar is open */}
      <div
        className={cn(
          "hidden mobile-overlay fixed inset-0 bg-black/50 z-40 backdrop-blur-sm",
          collapsed && "!hidden"
        )}
        onClick={onToggleCollapsed}
      />

      {/* Sidebar */}
      <div
        data-testid="left-sidebar"
        className={cn(
          "h-full bg-sidebar border-r border-border flex flex-col shrink-0 overflow-hidden relative z-20",
          !isResizing && "transition-[width] duration-200",
          "mobile-sidebar",
          collapsed && "mobile-sidebar-collapsed",
          // In desktop mode when collapsed, hide the border so the sidebar is fully hidden.
          isDesktop && collapsed && "border-r-0"
        )}
        style={{ width }}
      >
        {!collapsed && (
          <TitleBar
            onBeforeOpenSettings={handleBeforeOpenSettings}
            onToggleCollapsed={onToggleCollapsed}
          />
        )}
        <ProjectSidebar
          {...projectSidebarProps}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
        />

        {!collapsed && !isMobileTouch && onStartResize && (
          <div
            data-testid="left-sidebar-resize-handle"
            className={cn(
              "absolute right-0 top-0 bottom-0 w-0.5 z-10 cursor-col-resize transition-[background] duration-150",
              isResizing ? "bg-accent" : "bg-border-light hover:bg-accent"
            )}
            onMouseDown={(e) => onStartResize(e)}
          />
        )}
      </div>
    </>
  );
}
