import React from "react";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "./ui/select";
import { Tooltip, TooltipTrigger, TooltipContent, HelpIndicator } from "./ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { useModes } from "@/browser/hooks/useModes";
import type { UIMode, ModeDefinition } from "@/common/types/mode";
import { cn } from "@/common/lib/utils";

/** Fallback modes when API hasn't loaded yet */
const FALLBACK_MODES: ModeDefinition[] = [
  {
    name: "exec",
    label: "Exec",
    description: "Full execution mode with all tools enabled",
    instructions: "",
    source: "builtin",
    filePath: "",
  },
  {
    name: "plan",
    label: "Plan",
    description: "Read-only planning mode with propose_plan tool",
    instructions: "",
    source: "builtin",
    filePath: "",
  },
];

/** Get the active class for a mode based on its name */
function getModeActiveClass(modeName: string): string {
  switch (modeName) {
    case "exec":
      return "bg-exec-mode text-white";
    case "plan":
      return "bg-plan-mode text-white";
    default:
      return "bg-toggle-active text-toggle-text-active";
  }
}

const ModeHelpTooltip: React.FC<{ modes: ModeDefinition[] }> = (props) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <HelpIndicator>?</HelpIndicator>
    </TooltipTrigger>
    <TooltipContent align="center" className="max-w-80 whitespace-normal">
      {props.modes.map((m, i) => (
        <React.Fragment key={m.name}>
          {i > 0 && (
            <>
              <br />
              <br />
            </>
          )}
          <strong>{m.label}:</strong> {m.description}
        </React.Fragment>
      ))}
      <br />
      <br />
      Toggle with: {formatKeybind(KEYBINDS.TOGGLE_MODE)}
    </TooltipContent>
  </Tooltip>
);

interface ModeSelectorProps {
  mode: UIMode;
  onChange: (mode: UIMode) => void;
  workspaceId?: string;
  className?: string;
}

/**
 * ModeSelector - Dropdown for selecting agent behavior modes.
 * Styled to match the original toggle group appearance.
 * Loads custom modes from .mux/modes/ and ~/.mux/modes/ directories.
 */
export const ModeSelector: React.FC<ModeSelectorProps> = (props) => {
  const { modes: loadedModes } = useModes(props.workspaceId);
  const modes = loadedModes.length > 0 ? loadedModes : FALLBACK_MODES;
  const currentMode = modes.find((m) => m.name === props.mode);

  return (
    <div className={cn("flex items-center gap-1.5", props.className)}>
      <Select value={props.mode} onValueChange={props.onChange}>
        <SelectTrigger
          className={cn(
            "h-auto min-w-0 gap-0 border-0 bg-toggle-bg px-0 py-0 shadow-none",
            "focus:ring-0 focus:ring-offset-0",
            "[&>svg]:hidden" // Hide the chevron
          )}
        >
          <SelectValue>
            <span
              className={cn(
                "px-1.5 py-0.5 text-[11px] font-sans rounded-sm font-medium",
                getModeActiveClass(currentMode?.name ?? props.mode)
              )}
            >
              {currentMode?.label ?? props.mode}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {modes.map((m) => (
            <SelectItem key={m.name} value={m.name}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ModeHelpTooltip modes={modes} />
    </div>
  );
};
