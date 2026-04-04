import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/common/lib/utils";
import {
  ChevronRight,
  EllipsisVertical,
  Folder,
  FolderOpen,
  Palette,
  Pencil,
  Trash2,
  Plus,
} from "lucide-react";
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
      className="group relative ml-4 flex items-center gap-1 py-1.5 pr-1 pl-3 select-none"
      data-section-id={section.id}
    >
      {/* Expand/Collapse Button */}
      <button
        onClick={onToggleExpand}
        className="text-secondary hover:text-foreground flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
        aria-label={isExpanded ? "Collapse section" : "Expand section"}
        aria-expanded={isExpanded}
      >
        <span className="relative flex h-3.5 w-3.5 items-center justify-center">
          <ChevronRight
            className="absolute inset-0 h-3.5 w-3.5 opacity-0 transition-[opacity,transform] duration-200 group-hover:opacity-100"
            style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
          />
          {isExpanded ? (
            <FolderOpen
              className="h-3.5 w-3.5 transition-opacity duration-200 group-hover:opacity-0"
              style={{ color: sectionColor }}
            />
          ) : (
            <Folder
              className="h-3.5 w-3.5 transition-opacity duration-200 group-hover:opacity-0"
              style={{ color: sectionColor }}
            />
          )}
        </span>
      </button>

      {/* Section Name */}
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
            hasAttention ? "text-content-primary" : "text-content-secondary"
          )}
        >
          {section.name}
          <span className="text-muted ml-1.5 font-normal">({workspaceCount})</span>
        </button>
      )}

      {/* Right-side controls: add chat + section actions */}
      <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:opacity-100">
        {/* Add Chat — always visible on touch devices */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onAddWorkspace}
              className="text-secondary hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-sm transition-colors"
              aria-label="New chat in section"
            >
              <Plus className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>

        {/* Section actions kebab sits immediately to the right of New chat */}
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
              className="text-muted hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
              aria-label="Section actions"
            >
              <EllipsisVertical className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Section actions</TooltipContent>
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
