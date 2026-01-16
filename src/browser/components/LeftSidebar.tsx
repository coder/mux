import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import ProjectSidebar from "./ProjectSidebar";
import { TitleBar } from "./TitleBar";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface LeftSidebarProps {
  lastReadTimestamps: Record<string, number>;
  onToggleUnread: (workspaceId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  sortedWorkspacesByProject: Map<string, FrontendWorkspaceMetadata[]>;
  workspaceRecency: Record<string, number>;
}

export function LeftSidebar(props: LeftSidebarProps) {
  const { collapsed, onToggleCollapsed, ...projectSidebarProps } = props;
  const isDesktop = isDesktopMode();

  return (
    <>
      {/* Hamburger menu button - visible when sidebar is collapsed
          On mobile: positioned at top-left (sidebar slides off-screen)
          On desktop: positioned after the collapsed sidebar strip */}
      {collapsed && (
        <button
          onClick={onToggleCollapsed}
          title="Open sidebar"
          aria-label="Open sidebar menu"
          className={cn(
            "sidebar-toggle-btn fixed top-3 z-30 flex",
            "w-10 h-10 bg-sidebar border border-border-light rounded-md cursor-pointer",
            "items-center justify-center text-foreground text-xl transition-all duration-200",
            "shadow-[0_2px_4px_rgba(0,0,0,0.3)]",
            "hover:bg-hover hover:border-bg-light",
            "active:scale-95"
          )}
        >
          ☰
        </button>
      )}

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
        className={cn(
          "h-screen bg-sidebar border-r border-border flex flex-col shrink-0",
          "transition-all duration-200 overflow-hidden relative z-20",
          collapsed ? "w-5" : "w-72",
          "mobile-sidebar",
          collapsed && "mobile-sidebar-collapsed",
          // In desktop mode when collapsed, start border below titlebar height (32px)
          // so it aligns with titlebar bottom edge and doesn't cut through traffic lights
          isDesktop &&
            collapsed &&
            "border-r-0 after:absolute after:right-0 after:top-8 after:bottom-0 after:w-px after:bg-border"
        )}
      >
        {!collapsed && <TitleBar />}
        <ProjectSidebar
          {...projectSidebarProps}
          collapsed={collapsed}
          onToggleCollapsed={onToggleCollapsed}
        />
      </div>
    </>
  );
}
