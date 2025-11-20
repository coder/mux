import React from "react";

/**
 * Hook for number input with local state, validation, and clamping on blur.
 * Prevents typing interruption while ensuring valid persisted values.
 *
 * @param persistedValue - Current value from persistence layer
 * @param setPersisted - Function to update persisted value
 * @param min - Minimum allowed value
 * @param max - Maximum allowed value
 * @returns Object with localValue, handleChange, and handleBlur
 */
export function useClampedNumberInput(
  persistedValue: number,
  setPersisted: (value: number) => void,
  min: number,
  max: number
) {
  const [localValue, setLocalValue] = React.useState(persistedValue.toString());

  // Sync local state when persisted value changes (e.g., from other tabs)
  React.useEffect(() => {
    setLocalValue(persistedValue.toString());
  }, [persistedValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target.value;
    // Allow empty or valid partial numbers (1-3 digits for typical use)
    if (input === "" || /^\d{1,3}$/.test(input)) {
      setLocalValue(input);
    }
  };

  const handleBlur = () => {
    const num = parseInt(localValue);

    if (localValue === "" || isNaN(num)) {
      // Invalid input - revert to persisted value
      setLocalValue(persistedValue.toString());
    } else if (num < min) {
      // Below minimum - clamp to min
      setPersisted(min);
      setLocalValue(min.toString());
    } else if (num > max) {
      // Above maximum - clamp to max
      setPersisted(max);
      setLocalValue(max.toString());
    } else {
      // Valid - persist the value
      setPersisted(num);
      setLocalValue(num.toString());
    }
  };

  return { localValue, handleChange, handleBlur };
}
