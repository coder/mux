import { cn } from "@/common/lib/utils";

// The composer's inline pickers (agent mode, model) sit next to each other and open the same way, so
// drift between their panels is immediately visible. Placement and width stay with each picker.
export const COMPOSER_PICKER_PANEL_CLASS =
  "bg-surface-primary border-border-light overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)] outline-none";

export const COMPOSER_PICKER_DIVIDER_CLASS = "border-border-light";

export function composerPickerOptionClass(state: {
  isHighlighted: boolean;
  isSelected: boolean;
}): string {
  return cn(
    "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 text-[11px] font-medium transition-colors duration-100",
    state.isHighlighted ? "bg-hover text-foreground" : "bg-transparent hover:bg-hover",
    state.isSelected ? "text-foreground" : "text-light hover:text-foreground"
  );
}
