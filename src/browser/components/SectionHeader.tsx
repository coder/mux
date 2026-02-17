import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/common/lib/utils";
import { ChevronRight, Pencil, Trash2, Palette, MoreVertical } from "lucide-react";
import type { SectionConfig } from "@/common/types/project";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { resolveSectionColor, SECTION_COLOR_PALETTE } from "@/common/constants/ui";
import { HexColorPicker } from "react-colorful";

interface SectionHeaderProps {
  section: SectionConfig;
  isExpanded: boolean;
  workspaceCount: number;
  onToggleExpand: () => void;
  onAddWorkspace: () => void;
  onRename: (name: string) => void;
  onChangeColor: (color: string) => void;
  onDelete: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

export const SectionHeader: React.FC<SectionHeaderProps> = ({
  section,
  isExpanded,
  workspaceCount,
  onToggleExpand,
  onAddWorkspace,
  onRename,
  onChangeColor,
  onDelete,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(section.name);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [hexInputValue, setHexInputValue] = useState(section.color ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    if (showColorPicker) {
      const handleClickOutside = (e: MouseEvent) => {
        if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Node)) {
          setShowColorPicker(false);
        }
      };
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [showColorPicker]);

  const handleSubmitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== section.name) {
      onRename(trimmed);
    } else {
      setEditValue(section.name);
    }
    setIsEditing(false);
  };

  const sectionColor = resolveSectionColor(section.color);

  // Sync hex input when color changes from picker or presets
  useEffect(() => {
    setHexInputValue(sectionColor);
  }, [sectionColor]);

  return (
    <div
      className="group relative flex items-center gap-1 border-t border-white/5 px-2 py-1.5"
      style={{
        borderLeftWidth: 1,
        borderLeftColor: sectionColor,
        backgroundColor: '#1e1e1e',
      }}
      data-section-id={section.id}
    >
      {/* Expand/Collapse Button */}
      <button
        onClick={onToggleExpand}
        className="hover:text-foreground flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
        style={{ color: sectionColor }}
        aria-label={isExpanded ? "Collapse section" : "Expand section"}
        aria-expanded={isExpanded}
      >
        <ChevronRight
          size={16}
          className="transition-transform duration-200"
          style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </button>

      {/* Section Name */}
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmitRename();
            if (e.key === "Escape") {
              setEditValue(section.name);
              setIsEditing(false);
            }
          }}
          data-testid="section-rename-input"
          className="bg-background/50 text-foreground min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-xs font-medium outline-none"
        />
      ) : (
        <button
          onClick={onToggleExpand}
          onDoubleClick={() => setIsEditing(true)}
          className="min-w-0 flex-1 cursor-pointer truncate border-none bg-transparent p-0 text-left text-xs font-semibold"
          style={{ color: sectionColor }}
        >
          {section.name}
          <span className="text-muted ml-1.5 font-normal">({workspaceCount})</span>
        </button>
      )}

      {/* Kebab menu */}
      <Popover>
        <PopoverTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground hover:bg-hover ml-auto flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded border border-transparent bg-transparent p-0 hover:border-border-light"
            aria-label="Section menu"
          >
            <MoreVertical size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="bottom" sideOffset={4} className="w-52 p-1">
          <button className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap" onClick={() => onAddWorkspace?.()}>New workspace</button>
          <button className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap" onClick={() => setShowColorPicker(true)}>Change section color</button>
          <button className="text-foreground bg-background hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap" onClick={() => setIsEditing(true)}>Rename section</button>
          <div className="my-1 h-px bg-white/10" />
          <button className="text-danger hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left text-xs whitespace-nowrap flex items-center gap-2" onClick={() => onDelete?.({} as React.MouseEvent<HTMLButtonElement>)}><Trash2 className="h-3 w-3 shrink-0" />Delete...</button>
        </PopoverContent>
      </Popover>

      {/* Action Buttons (visible on hover) */}
      <div className="hidden flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {/* Color Picker trigger (hidden hover button) */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="text-muted hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
              aria-label="Change color"
            >
              <Palette size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Change color</TooltipContent>
        </Tooltip>

        {/* Rename */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setIsEditing(true)}
              className="text-muted hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
              aria-label="Rename section"
            >
              <Pencil size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Rename</TooltipContent>
        </Tooltip>

        {/* Delete */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={(e) => onDelete(e)}
              className="text-muted hover:text-danger-light hover:bg-danger-light/10 flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 transition-colors"
              aria-label="Delete section"
            >
              <Trash2 size={12} />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete section</TooltipContent>
        </Tooltip>

        {/* Add Workspace */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onAddWorkspace}
              className="text-secondary hover:text-foreground hover:bg-hover flex h-5 w-5 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-sm transition-colors"
              aria-label="New workspace in section"
            >
              +
            </button>
          </TooltipTrigger>
          <TooltipContent>New workspace</TooltipContent>
        </Tooltip>
      </div>

      {/* Color picker popover — rendered outside hidden div so it
         shows when triggered from context menu */}
      {showColorPicker && (
        <div
          ref={colorPickerRef}
          className="bg-background border-border absolute top-full right-0 z-50 mt-1 rounded border p-2 shadow-lg"
        >
          {/* Preset swatches */}
          <div className="mb-2 grid grid-cols-5 gap-1">
            {SECTION_COLOR_PALETTE.map(([name, color]) => (
              <button
                key={color}
                onClick={() => {
                  onChangeColor(color);
                  setShowColorPicker(false);
                }}
                className={cn(
                  "h-5 w-5 rounded border-2 transition-transform hover:scale-110",
                  sectionColor === color ? "border-white" : "border-transparent"
                )}
                style={{ backgroundColor: color }}
                title={name}
                aria-label={`Set color to ${name}`}
              />
            ))}
          </div>
          {/* Full color picker */}
          <div className="section-color-picker">
            <HexColorPicker
              color={sectionColor}
              onChange={(newColor) => onChangeColor(newColor)}
            />
          </div>
          {/* Hex input */}
          <div className="mt-2 flex items-center gap-1.5">
            <input
              type="text"
              value={hexInputValue}
              onChange={(e) => {
                const value = e.target.value;
                setHexInputValue(value);
                // Only apply valid hex colors
                if (/^#[0-9a-fA-F]{6}$/.test(value)) {
                  onChangeColor(value);
                }
              }}
              className="bg-background/50 text-foreground w-full rounded border border-white/20 px-1.5 py-0.5 text-xs outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};
