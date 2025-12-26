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
    icon: "⚡",
    color: "var(--color-exec-mode)",
    instructions: "",
    source: "builtin",
    filePath: "",
  },
  {
    name: "plan",
    label: "Plan",
    description: "Read-only planning mode with propose_plan tool",
    icon: "📋",
    color: "var(--color-plan-mode)",
    instructions: "",
    source: "builtin",
    filePath: "",
  },
];

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
          <strong>
            {m.icon} {m.label}:
          </strong>{" "}
          {m.description}
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
 * Loads custom modes from .mux/modes/ and ~/.mux/modes/ directories.
 */
export const ModeSelector: React.FC<ModeSelectorProps> = (props) => {
  const { modes: loadedModes } = useModes(props.workspaceId);
  const modes = loadedModes.length > 0 ? loadedModes : FALLBACK_MODES;
  const currentMode = modes.find((m) => m.name === props.mode);

  return (
    <div className={cn("flex items-center gap-1.5", props.className)}>
      <Select value={props.mode} onValueChange={props.onChange}>
        <SelectTrigger className="w-[100px] [@container(max-width:550px)]:w-[80px]">
          <SelectValue>
            <span
              className="flex items-center gap-1"
              style={{
                color: currentMode?.color,
              }}
            >
              {currentMode?.icon && <span>{currentMode.icon}</span>}
              <span className="[@container(max-width:550px)]:hidden">
                {currentMode?.label ?? props.mode}
              </span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {modes.map((m) => (
            <SelectItem key={m.name} value={m.name}>
              <span className="flex items-center gap-1.5" style={{ color: m.color }}>
                {m.icon && <span>{m.icon}</span>}
                <span>{m.label}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ModeHelpTooltip modes={modes} />
    </div>
  );
};
