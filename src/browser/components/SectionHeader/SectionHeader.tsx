import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/common/lib/utils";
import { ChevronRight, EllipsisVertical, Palette, Pencil, Trash2, Plus } from "lucide-react";
import type { SectionConfig } from "@/common/types/project";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipIfPresent } from "../Tooltip/Tooltip";
import { resolveSectionColor, SECTION_COLOR_PALETTE } from "@/common/constants/ui";
import { HexColorPicker } from "react-colorful";
import { useContextMenuPosition } from "../../hooks/useContextMenuPosition";
import { PositionedMenu, PositionedMenuItem } from "../PositionedMenu/PositionedMenu";

interface SectionHeaderProps {
  section: SectionConfig;
  isExpanded: boolean;
  workspaceCount: number;
  hasAttention: boolean;
  onToggleExpand: () => void;
  onAddWorkspace: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
  onDelete: (anchorEl: HTMLElement) => void;
  autoStartEditing?: boolean;
  onAutoCreateAbandon?: () => void;
  onAutoCreateRenameCancel?: () => void;
}

// Section rows already expose a large click target via the full header, so keep
// the inline icon buttons compact even on coarse-pointer layouts.
const COMPACT_SECTION_ICON_BUTTON_CLASSES = "!min-h-0 !min-w-0";

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  section,
  isExpanded,
  workspaceCount,
  hasAttention,
  onToggleExpand,
  onAddWorkspace,
  onRename,
  onChangeColor,
  onDelete,
  autoStartEditing = false,
  onAutoCreateAbandon,
  onAutoCreateRenameCancel,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(section.name);
  const [hasEditedName, setHasEditedName] = useState(false);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [hexInputValue, setHexInputValue] = useState(section.color ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const autoStartHandledRef = useRef(false);
  const wasMenuOpenOnPointerDownRef = useRef(false);
  const sectionMenu = useContextMenuPosition();

  const startEditing = () => {
    setEditValue(section.name);
    setHasEditedName(false);
    setIsEditing(true);
  };

  useEffect(() => {
    if (!autoStartEditing || autoStartHandledRef.current) {
      return;
    }
    autoStartHandledRef.current = true;
    setEditValue(section.name);
    setHasEditedName(false);
    setIsEditing(true);
  }, [autoStartEditing, section.name]);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleSubmitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== section.name) {
      onRename(trimmed);
    } else if (onAutoCreateRenameCancel) {
      // Blur/submit with no committed rename should exit auto-create mode,
      // otherwise a later Escape can still route through abandon/delete.
      onAutoCreateRenameCancel();
      setEditValue(section.name);
    } else {
      setEditValue(section.name);
    }
    setHasEditedName(false);
    setIsEditing(false);
  };

  const sectionColor = resolveSectionColor(section.color);

  // Keep hex input in sync while the picker is open, matching project menu behavior.
  useEffect(() => {
    if (!showColorPicker) {
      return;
    }
    setHexInputValue(sectionColor);
  }, [sectionColor, showColorPicker]);

  return (
    <div
      className="group relative flex items-center gap-1 border-t border-white/5 px-2 py-1.5 select-none"
      style={{
        // Keep sections visually distinct from project rows so age buckets do not read like
        // another folder level in the hierarchy after reverting the sidebar redesign.
        backgroundColor: `${sectionColor}10`,
        borderLeftWidth: 3,
        borderLeftColor: sectionColor,
      }}
      data-section-id={section.id}
    >
      <button
        onClick={onToggleExpand}
        className={cn(
          "text-secondary hover:text-foreground flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors",
          COMPACT_SECTION_ICON_BUTTON_CLASSES
        )}
        aria-label={isExpanded ? "Collapse section" : "Expand section"}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          size={12}
          className="h-3 w-3 shrink-0 transition-transform duration-200"
          strokeWidth={1.8}
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </button>

      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => {
            setHasEditedName(true);
            setEditValue(e.target.value);
          }}
          onBlur={handleSubmitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmitRename();
            if (e.key === "Escape") {
              const hasEditedInCurrentInput = e.currentTarget.value !== section.name;
              if (onAutoCreateAbandon && !hasEditedName && !hasEditedInCurrentInput) {
                onAutoCreateAbandon();
                return;
              }
              if (onAutoCreateRenameCancel && (hasEditedName || hasEditedInCurrentInput)) {
                onAutoCreateRenameCancel();
              }
              setEditValue(section.name);
              setHasEditedName(false);
              setIsEditing(false);
            }
          }}
          data-testid="section-rename-input"
          className="bg-background/50 text-foreground min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-xs font-medium outline-none select-text"
        />
      ) : (
        <button
          onClick={onToggleExpand}
          onDoubleClick={startEditing}
          className={cn(
            "min-w-0 flex-1 cursor-pointer truncate border-none bg-transparent p-0 text-left text-xs font-medium",
            hasAttention ? "text-content-primary" : "text-foreground"
          )}
        >
          {section.name}
          <span className="text-muted ml-1.5 font-normal">({workspaceCount})</span>
        </button>
      )}

      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onPointerDownCapture={() => {
                wasMenuOpenOnPointerDownRef.current = sectionMenu.isOpen;
              }}
              onClick={(e: React.MouseEvent) => {
                // Radix dismisses on outside pointer-down before this click handler runs.
                // Preserve explicit toggle behavior by honoring the pre-click open state.
                const shouldCloseMenu = sectionMenu.isOpen || wasMenuOpenOnPointerDownRef.current;
                wasMenuOpenOnPointerDownRef.current = false;
                if (shouldCloseMenu) {
                  setShowColorPicker(false);
                  sectionMenu.close();
                  return;
                }
                sectionMenu.onContextMenu(e);
              }}
              className={cn(
                "text-muted hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors",
                COMPACT_SECTION_ICON_BUTTON_CLASSES
              )}
              aria-label="Section actions"
            >
              <EllipsisVertical className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Section actions</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onAddWorkspace}
              className={cn(
                "text-secondary hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-sm transition-colors",
                COMPACT_SECTION_ICON_BUTTON_CLASSES
              )}
              aria-label="New chat in section"
            >
              <Plus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>

        <PositionedMenu
          open={sectionMenu.isOpen}
          onOpenChange={(open) => {
            if (!open) {
              setShowColorPicker(false);
            }
            sectionMenu.onOpenChange(open);
          }}
          position={sectionMenu.position}
        >
          <PositionedMenuItem
            icon={<Palette />}
            label="Change color"
            onClick={() => {
              setShowColorPicker((open) => !open);
            }}
          />
          {showColorPicker && (
            <div className="bg-background border-border mx-1 my-1 rounded border p-2">
              <div className="mb-2 grid grid-cols-5 gap-1">
                {SECTION_COLOR_PALETTE.map(([name, color]) => (
                  <TooltipIfPresent key={color} tooltip={name} side="bottom" align="center">
                    <button
                      onClick={() => {
                        onChangeColor(color);
                        setHexInputValue(color);
                        setShowColorPicker(false);
                      }}
                      className={cn(
                        "h-5 w-5 rounded border-2 transition-transform hover:scale-110",
                        sectionColor === color ? "border-white" : "border-transparent"
                      )}
                      style={{ backgroundColor: color }}
                      aria-label={`Set section color to ${name}`}
                    />
                  </TooltipIfPresent>
                ))}
              </div>
              <div className="section-color-picker">
                <HexColorPicker
                  color={sectionColor}
                  onChange={(newColor) => {
                    setHexInputValue(newColor);
                    onChangeColor(newColor);
                  }}
                />
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <input
                  type="text"
                  value={hexInputValue}
                  onChange={(e) => {
                    const value = e.target.value;
                    setHexInputValue(value);
                    if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                      onChangeColor(value);
                    }
                  }}
                  className="bg-background/50 text-foreground w-full rounded border border-white/20 px-1.5 py-0.5 text-xs outline-none select-text"
                />
              </div>
            </div>
          )}
          <PositionedMenuItem
            icon={<Pencil />}
            label="Rename"
            onClick={() => {
              startEditing();
              setShowColorPicker(false);
              sectionMenu.close();
            }}
          />
          <PositionedMenuItem
            icon={<Trash2 />}
            label="Delete section"
            variant="destructive"
            onClick={(event) => {
              onDelete(event.currentTarget);
              setShowColorPicker(false);
              sectionMenu.close();
            }}
          />
        </PositionedMenu>
      </div>
    </div>
  );
};
