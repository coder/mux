import React, { useEffect, useState, useRef } from "react";
console.log("LEFT_SIDEBAR_MARKER_TEST");
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import ProjectSidebar from "./ProjectSidebar";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface LeftSidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  widthPx?: number;
  isResizing?: boolean;
  onStartResize?: (e: React.MouseEvent) => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
  muxChatProjectPath: string | null;
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
  const isMobileTouch =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 768px) and (pointer: coarse)").matches;

  const width = collapsed ? "40px" : `${widthPx ?? 288}px`;

  // Track whether the sidebar content should be visible.
  // Hidden on initial mount (to prevent squished flash) and during
  // expand transitions (collapsed → expanded) until the width
  // animation finishes.
  const [contentVisible, setContentVisible] = useState(false);
  const [enableTransition, setEnableTransition] = useState(false);
  const prevCollapsed = useRef(collapsed);
  const isInitialMount = useRef(true);

  // Initial mount: reveal content after one frame (width has settled).
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setContentVisible(true);
        setEnableTransition(true);
        isInitialMount.current = false;
      });
    });
  }, []);

  // When expanding (collapsed → not collapsed), hide content during
  // the width transition, then reveal after it completes.
  useEffect(() => {
    if (isInitialMount.current) {
      prevCollapsed.current = collapsed;
      return;
    }

    if (prevCollapsed.current && !collapsed) {
      // Expanding: hide content immediately, show after width transition.
      setContentVisible(false);
      const timer = setTimeout(() => {
        setContentVisible(true);
      }, 220); // slightly longer than the 200ms width transition
      prevCollapsed.current = collapsed;
      return () => clearTimeout(timer);
    }

    prevCollapsed.current = collapsed;
  }, [collapsed]);

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
          enableTransition && !isResizing && "transition-[width] duration-200",
          "mobile-sidebar",
          collapsed && "mobile-sidebar-collapsed",
          isDesktop &&
            collapsed &&
            "border-r-0 after:absolute after:right-0 after:top-0 after:bottom-0 after:w-px after:bg-border"
        )}
        style={{ width }}
      >
        {/* Hide content until layout is settled to prevent squished flash */}
        <div
          className={cn(
            "flex flex-col flex-1 min-h-0",
            contentVisible ? "opacity-100" : "opacity-0"
          )}
          style={{ transition: contentVisible ? "opacity 100ms ease-in" : "none" }}
        >
          <ProjectSidebar
            {...projectSidebarProps}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
          />
        </div>

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
