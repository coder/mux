import * as React from "react";
import { cn } from "@/common/lib/utils";

interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  "aria-label"?: string;
}

/**
 * A simple toggle switch component.
 * Matches the existing toggle pattern used in Settings sections.
 */
const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  (
    { checked, onCheckedChange, disabled = false, className, title, "aria-label": ariaLabel },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        title={title}
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
            "pointer-events-none inline-flex h-6 w-11 items-center rounded-full border-2 border-transparent transition-colors",
            checked ? "bg-accent" : "bg-zinc-600"
          )}
        >
          <span
            className={cn(
              "pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform",
              checked ? "translate-x-5" : "translate-x-0"
            )}
          />
        </span>
      </button>
    );
  }
);
Switch.displayName = "Switch";

export { Switch };
