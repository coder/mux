import React from "react";
import { cn } from "@/common/lib/utils";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import ProjectSidebar from "./ProjectSidebar";
import { TitleBar } from "./TitleBar";

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

  return (
    <>
      {/* Hamburger menu button - only visible on mobile */}
      {collapsed && (
        <button
          onClick={onToggleCollapsed}
          title="Open sidebar"
          aria-label="Open sidebar menu"
          className={cn(
            "hidden mobile-menu-btn fixed top-3 left-3 z-[998]",
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
          "hidden mobile-overlay fixed inset-0 bg-black/50 z-[999] backdrop-blur-sm",
          collapsed && "!hidden"
        )}
        onClick={onToggleCollapsed}
      />

      {/* Sidebar */}
      <div
        className={cn(
          "h-screen bg-sidebar border-r border-border flex flex-col shrink-0",
          "transition-all duration-200 overflow-hidden relative z-[100]",
          collapsed ? "w-8" : "w-72",
          "mobile-sidebar",
          collapsed && "mobile-sidebar-collapsed"
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
