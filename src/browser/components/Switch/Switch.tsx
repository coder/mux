import * as React from "react";
import { getTextContent, TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import { cn } from "@/common/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  /** "default" (h-6 w-11) or "sm" (h-4 w-7) */
  size?: "default" | "sm";
  className?: string;
  title?: React.ReactNode;
  tooltip?: React.ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

/**
 * A simple toggle switch component.
 * Matches the existing toggle pattern used in Settings sections.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    {
      checked,
      onCheckedChange,
      disabled = false,
      size = "default",
      className,
      title,
      tooltip,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
    },
    ref
  ) => {
    const isSmall = size === "sm";
    const resolvedTooltip = tooltip ?? title;
    const tooltipLabel = getTextContent(resolvedTooltip).trim();
    const resolvedAriaLabel =
      ariaLabel != null || ariaLabelledBy != null || tooltipLabel === "" ? ariaLabel : tooltipLabel;
    const button = (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={resolvedAriaLabel}
        aria-labelledby={ariaLabelledBy}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-flex items-center rounded-full border-2 border-transparent transition-colors",
            isSmall ? "h-4 w-7" : "h-6 w-11",
            checked ? "bg-accent" : "bg-zinc-600"
          )}
        >
          <span
            className={cn(
              "pointer-events-none block rounded-full bg-background shadow-lg ring-0 transition-transform",
              isSmall ? "h-3 w-3" : "h-5 w-5",
              checked ? (isSmall ? "translate-x-3" : "translate-x-5") : "translate-x-0"
            )}
          />
        </span>
      </button>
    );

    return <TooltipIfPresent tooltip={resolvedTooltip}>{button}</TooltipIfPresent>;
  }
);
Switch.displayName = "Switch";

export { Switch };
