import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import ProjectSidebar from "./ProjectSidebar";
import { TitleBar } from "./TitleBar";
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

  const width = collapsed ? "20px" : `${widthPx ?? 288}px`;

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
          // In desktop mode when collapsed, start border below titlebar height (32px)
          // so it aligns with titlebar bottom edge and doesn't cut through traffic lights
          isDesktop &&
            collapsed &&
            "border-r-0 after:absolute after:right-0 after:top-8 after:bottom-0 after:w-px after:bg-border"
        )}
        style={{ width }}
      >
        {!collapsed && <TitleBar onBeforeOpenSettings={handleBeforeOpenSettings} />}
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
