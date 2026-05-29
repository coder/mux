import { useState, useEffect } from "react";

/**
 * Returns a debounced version of the input value.
 * The returned value only updates after the input has stopped changing
 * for the specified delay.
 *
 * @param value - The value to debounce
 * @param delayMs - Debounce delay in milliseconds (default: 300ms)
 * @returns The debounced value
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
