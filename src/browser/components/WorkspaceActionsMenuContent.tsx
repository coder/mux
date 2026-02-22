import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { ArchiveIcon } from "./icons/ArchiveIcon";
import { GitBranch, Link2, Maximize2, Pencil, Server } from "lucide-react";
import React from "react";

interface WorkspaceActionButtonProps {
  label: string;
  shortcut?: string;
  shortcutClassName?: string;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  testId?: string;
}

function WorkspaceActionButton(props: WorkspaceActionButtonProps) {
  return (
    <button
      type="button"
      className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap"
      onClick={props.onClick}
      data-testid={props.testId}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3">{props.icon}</span>
        {props.label}
        {props.shortcut && (
          <span className={`text-muted ml-auto text-[10px] ${props.shortcutClassName ?? ""}`}>
            ({props.shortcut})
          </span>
        )}
      </span>
    </button>
  );
}

interface WorkspaceActionsMenuContentProps {
  /** Workspace title actions only make sense in the left sidebar where title text is visible. */
  onEditTitle?: (() => void) | null;
  /** Workspace-level settings action currently surfaced from the workspace menu bar. */
  onConfigureMcp?: (() => void) | null;
  /** Mobile workspace-header action: open immersive review in full-screen touch mode. */
  onOpenTouchFullscreenReview?: (() => void) | null;
  onForkChat?: ((anchorEl: HTMLElement) => void) | null;
  onShareTranscript?: (() => void) | null;
  onArchiveChat?: ((anchorEl: HTMLElement) => void) | null;
  onCloseMenu: () => void;
  linkSharingEnabled: boolean;
  isMuxHelpChat: boolean;
  shortcutClassName?: string;
  configureMcpTestId?: string;
}

/**
 * Shared menu content for workspace actions, used by both sidebar rows and the workspace menu bar.
 * Keeping these actions centralized prevents menu drift between entry points.
 */
export const WorkspaceActionsMenuContent: React.FC<WorkspaceActionsMenuContentProps> = (props) => {
  return (
    <>
      {props.onEditTitle && (
        <WorkspaceActionButton
          label="Edit chat title"
          shortcut={formatKeybind(KEYBINDS.EDIT_WORKSPACE_TITLE)}
          shortcutClassName={props.shortcutClassName}
          icon={<Pencil className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onEditTitle?.();
          }}
        />
      )}
      {props.onConfigureMcp && (
        <WorkspaceActionButton
          label="Configure MCP servers"
          shortcut={formatKeybind(KEYBINDS.CONFIGURE_MCP)}
          shortcutClassName={props.shortcutClassName}
          icon={<Server className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onConfigureMcp?.();
          }}
          testId={props.configureMcpTestId}
        />
      )}
      {props.onOpenTouchFullscreenReview && !props.isMuxHelpChat && (
        <WorkspaceActionButton
          label="Mobile full-screen review"
          icon={<Maximize2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onOpenTouchFullscreenReview?.();
          }}
        />
      )}
      {props.onForkChat && !props.isMuxHelpChat && (
        <WorkspaceActionButton
          label="Fork chat"
          icon={<GitBranch className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onForkChat?.(e.currentTarget);
          }}
        />
      )}
      {props.onShareTranscript && props.linkSharingEnabled === true && !props.isMuxHelpChat && (
        <WorkspaceActionButton
          label="Share transcript"
          shortcut={formatKeybind(KEYBINDS.SHARE_TRANSCRIPT)}
          shortcutClassName={props.shortcutClassName}
          icon={<Link2 className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onShareTranscript?.();
          }}
        />
      )}
      {props.onArchiveChat && !props.isMuxHelpChat && (
        <WorkspaceActionButton
          label="Archive chat"
          shortcut={formatKeybind(KEYBINDS.ARCHIVE_WORKSPACE)}
          shortcutClassName={props.shortcutClassName}
          icon={<ArchiveIcon className="h-3 w-3 shrink-0" />}
          onClick={(e) => {
            e.stopPropagation();
            props.onCloseMenu();
            props.onArchiveChat?.(e.currentTarget);
          }}
        />
      )}
    </>
  );
};
