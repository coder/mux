import React from "react";
import { ToggleGroup, type ToggleOption } from "./ToggleGroup";
import { TooltipWrapper, Tooltip, HelpIndicator } from "./Tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import type { UIMode } from "@/common/types/mode";
import { cn } from "@/common/lib/utils";

const MODE_OPTIONS: Array<ToggleOption<UIMode>> = [
  { value: "exec", label: "Exec", activeClassName: "bg-exec-mode text-white" },
  { value: "plan", label: "Plan", activeClassName: "bg-plan-mode text-white" },
];

const ModeHelpTooltip: React.FC = () => (
  <TooltipWrapper inline>
    <HelpIndicator>?</HelpIndicator>
    <Tooltip className="tooltip" align="center" width="wide">
      <strong>Exec Mode:</strong> AI edits files and executes commands
      <br />
      <br />
      <strong>Plan Mode:</strong> AI proposes plans but does not edit files
      <br />
      <br />
      Toggle with: {formatKeybind(KEYBINDS.TOGGLE_MODE)}
    </Tooltip>
  </TooltipWrapper>
);

interface ModeSelectorProps {
  mode: UIMode;
  onChange: (mode: UIMode) => void;
  className?: string;
}

/**
 * ModeSelector - UI control for switching between Exec and Plan modes
 * Renders responsive layouts with different sizing for different container widths
 */
export const ModeSelector: React.FC<ModeSelectorProps> = ({ mode, onChange, className }) => {
  return (
    <>
      {/* Full mode selector with labels - visible on wider containers */}
      <div
        className={cn("flex items-center gap-1.5 [@container(max-width:550px)]:hidden", className)}
      >
        <div
          className={cn(
            "rounded-md transition-colors",
            mode === "exec" &&
              "[&>button:first-of-type]:bg-exec-mode [&>button:first-of-type]:text-white [&>button:first-of-type]:hover:bg-exec-mode-hover",
            mode === "plan" &&
              "[&>button:last-of-type]:bg-plan-mode [&>button:last-of-type]:text-white [&>button:last-of-type]:hover:bg-plan-mode-hover"
          )}
        >
          <ToggleGroup<UIMode> options={MODE_OPTIONS} value={mode} onChange={onChange} />
        </div>
        <ModeHelpTooltip />
      </div>

      {/* Mode Switch - compact version for narrow containers */}
      <div className="ml-auto hidden items-center gap-1.5 [@container(max-width:550px)]:flex">
        <ToggleGroup<UIMode> options={MODE_OPTIONS} value={mode} onChange={onChange} compact />
        <ModeHelpTooltip />
      </div>
    </>
  );
};
