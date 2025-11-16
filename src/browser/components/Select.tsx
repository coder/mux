import React from "react";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[] | string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  "aria-label"?: string;
}

/**
 * Reusable select component with consistent styling
 * Centralizes select styling to avoid duplication and ensure consistent UX
 */
export function Select({
  value,
  options,
  onChange,
  disabled = false,
  className = "",
  id,
  "aria-label": ariaLabel,
}: SelectProps) {
  // Normalize options to SelectOption format
  const normalizedOptions: SelectOption[] = options.map((opt) =>
    typeof opt === "string" ? { value: opt, label: opt } : opt
  );

  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={`bg-separator text-foreground border-border-medium focus:border-accent rounded border px-1 py-0.5 text-xs focus:outline-none disabled:opacity-50 ${className}`}
    >
      {normalizedOptions.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
