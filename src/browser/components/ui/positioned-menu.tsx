import React from "react";
import type { ContextMenuPosition } from "@/browser/hooks/useContextMenuPosition";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { cn } from "@/common/lib/utils";

// ---------------------------------------------------------------------------
// PositionedMenu — Popover anchored at a fixed {x, y} screen position
// ---------------------------------------------------------------------------

interface PositionedMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  position: ContextMenuPosition | null;
  children: React.ReactNode;
  /** Tailwind width class (default: "w-[180px]") */
  className?: string;
}

/**
 * A lightweight popover menu anchored at an arbitrary screen position.
 *
 * Replaces the duplicated Popover+PopoverAnchor+invisible-span boilerplate
 * used across ChatPane transcript, WorkspaceListItem draft, etc.
 */
export function PositionedMenu(props: PositionedMenuProps) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      {props.position && (
        <PopoverAnchor asChild>
          <span
            style={{
              position: "fixed",
              left: props.position.x,
              top: props.position.y,
              width: 0,
              height: 0,
            }}
          />
        </PopoverAnchor>
      )}
      <PopoverContent
        align="start"
        side="right"
        sideOffset={0}
        className={cn("!min-w-0 p-1", props.className ?? "w-[180px]")}
        onClick={(e) => e.stopPropagation()}
      >
        {props.children}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// PositionedMenuItem — icon + label + optional shortcut hint
// ---------------------------------------------------------------------------

interface PositionedMenuItemProps {
  icon: React.ReactNode;
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  /** Optional keybind hint (e.g. "⌘K") rendered as muted text on the right */
  shortcut?: string;
  disabled?: boolean;
}

/**
 * Standard menu item button with icon, label, and optional keybind hint.
 *
 * Matches the styling used in WorkspaceListItem overflow menus so all
 * positioned menus share a consistent look.
 */
export function PositionedMenuItem(props: PositionedMenuItemProps) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap disabled:pointer-events-none disabled:opacity-50"
      onClick={(e) => {
        e.stopPropagation();
        props.onClick(e);
      }}
    >
      <span className="flex items-center gap-2">
        <span className="h-3 w-3 shrink-0 [&_svg]:h-3 [&_svg]:w-3">{props.icon}</span>
        {props.label}
        {props.shortcut && (
          <span className="text-muted ml-auto text-[10px]">({props.shortcut})</span>
        )}
      </span>
    </button>
  );
}
