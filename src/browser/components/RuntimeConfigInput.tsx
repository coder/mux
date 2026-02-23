import { useId } from "react";

import { cn } from "@/common/lib/utils";

/**
 * Shared runtime option input used by creation and settings screens.
 * Keeps labels/inputs visually and behaviorally aligned across both flows.
 */
export function RuntimeConfigInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  hasError?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
  inputClassName?: string;
}) {
  const autoId = useId();
  const inputId = props.id ?? autoId;

  return (
    <div className={cn("flex items-center gap-2", props.className)}>
      <label
        htmlFor={inputId}
        className={cn("text-muted-foreground text-xs", props.labelClassName)}
      >
        {props.label}
      </label>
      <input
        id={inputId}
        aria-label={props.ariaLabel ?? props.label}
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        className={cn(
          "border-border-medium bg-background-secondary text-foreground placeholder:text-muted focus:border-accent h-7 rounded border px-2 text-xs focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          props.inputClassName,
          props.hasError && "border-red-500"
        )}
      />
    </div>
  );
}
