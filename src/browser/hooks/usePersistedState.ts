import type { Dispatch, SetStateAction } from "react";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { getStorageChangeEvent } from "@/common/constants/events";

type SetValue<T> = T | ((prev: T) => T);

interface Subscriber {
  callback: () => void;
  componentId: string;
  listener: boolean;
}

const subscribersByKey = new Map<string, Set<Subscriber>>();

function addSubscriber(key: string, subscriber: Subscriber): () => void {
  const subs = subscribersByKey.get(key) ?? new Set<Subscriber>();
  subs.add(subscriber);
  subscribersByKey.set(key, subs);

  return () => {
    const current = subscribersByKey.get(key);
    if (!current) return;
    current.delete(subscriber);
    if (current.size === 0) {
      subscribersByKey.delete(key);
    }
  };
}

function notifySubscribers(key: string, origin?: string) {
  const subs = subscribersByKey.get(key);
  if (!subs) return;

  for (const sub of subs) {
    // If listener=false, only react to updates originating from this hook instance.
    if (!sub.listener) {
      if (!origin || origin !== sub.componentId) continue;
    }
    sub.callback();
  }
}

let storageListenerInstalled = false;
function ensureStorageListenerInstalled() {
  if (storageListenerInstalled) return;
  if (typeof window === "undefined") return;

  window.addEventListener("storage", (e: StorageEvent) => {
    if (!e.key) return;
    // Cross-tab update: only listener=true subscribers should react.
    notifySubscribers(e.key);
  });

  storageListenerInstalled = true;
}
/**
 * Read a persisted state value from localStorage (non-hook version)
 * Mirrors the reading logic from usePersistedState
 *
 * @param key - The localStorage key
 * @param defaultValue - Value to return if key doesn't exist or parsing fails
 * @returns The parsed value or defaultValue
 */
export function readPersistedState<T>(key: string, defaultValue: T): T {
  if (typeof window === "undefined" || !window.localStorage) {
    return defaultValue;
  }

  try {
    const storedValue = window.localStorage.getItem(key);
    if (storedValue === null || storedValue === "undefined") {
      return defaultValue;
    }
    return JSON.parse(storedValue) as T;
  } catch (error) {
    console.error(`Failed to read persisted state for key "${key}":`, error);
    return defaultValue;
  }
}

/**
 * Read a persisted string value from localStorage.
 *
 * Unlike readPersistedState(), this tolerates values that were written as raw
 * strings (not JSON) by legacy code.
 */
export function readPersistedString(key: string): string | undefined {
  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }

  const storedValue = window.localStorage.getItem(key);
  if (storedValue === null || storedValue === "undefined") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(storedValue);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Fall through to raw string.
  }

  return storedValue;
}

/**
 * Update a persisted state value from outside the hook.
 * This is useful when you need to update state from a different component/context
 * that doesn't have access to the setter (e.g., command palette updating workspace state).
 *
 * Supports functional updates to avoid races when toggling values.
 *
 * @param key - The same localStorage key used in usePersistedState
 * @param value - The new value to set, or a functional updater
 * @param defaultValue - Optional default value when reading existing state for functional updates
 */
export function updatePersistedState<T>(
  key: string,
  value: T | ((prev: T) => T),
  defaultValue?: T
): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    const newValue: T | null | undefined =
      typeof value === "function"
        ? (value as (prev: T) => T)(readPersistedState(key, defaultValue as T))
        : value;

    if (newValue === undefined || newValue === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(newValue));
    }

    // Notify same-tab subscribers (usePersistedState) immediately.
    notifySubscribers(key);

    // Dispatch custom event for same-tab synchronization for non-hook listeners.
    // No origin since this is an external update - all listeners should receive it.
    const customEvent = new CustomEvent(getStorageChangeEvent(key), {
      detail: { key, newValue },
    });
    window.dispatchEvent(customEvent);
  } catch (error) {
    console.warn(`Error writing to localStorage key "${key}":`, error);
  }
}

interface UsePersistedStateOptions {
  /** Enable listening to storage changes from other components/tabs */
  listener?: boolean;
}

/**
 * Custom hook that persists state to localStorage with automatic synchronization.
 * Follows React's useState API while providing localStorage persistence.
 *
 * @param key - Unique localStorage key
 * @param initialValue - Default value if localStorage is empty or invalid
 * @param options - Optional configuration { listener: true } for cross-component sync
 * @returns [state, setState] tuple matching useState API
 */
export function usePersistedState<T>(
  key: string,
  initialValue: T,
  options?: UsePersistedStateOptions
): [T, Dispatch<SetStateAction<T>>] {
  // Unique component ID for distinguishing self-updates.
  const componentIdRef = useRef(Math.random().toString(36));

  ensureStorageListenerInstalled();

  const subscribe = useCallback(
    (callback: () => void) => {
      return addSubscriber(key, {
        callback,
        componentId: componentIdRef.current,
        listener: Boolean(options?.listener),
      });
    },
    [key, options?.listener]
  );

  // Match the previous `usePersistedState` behavior: `initialValue` is only used
  // as the default when no value is stored; changes to `initialValue` should not
  // reinitialize state.
  const initialValueRef = useRef(initialValue);

  // useSyncExternalStore requires getSnapshot() to be referentially stable when
  // the underlying store value is unchanged. Since localStorage values are JSON,
  // we cache the parsed value by raw string.
  const snapshotRef = useRef<{ key: string; raw: string | null; value: T } | null>(null);

  const getSnapshot = useCallback((): T => {
    if (typeof window === "undefined" || !window.localStorage) {
      return initialValueRef.current;
    }

    try {
      const raw = window.localStorage.getItem(key);

      if (raw === null || raw === "undefined") {
        if (snapshotRef.current?.key === key && snapshotRef.current.raw === null) {
          return snapshotRef.current.value;
        }

        snapshotRef.current = {
          key,
          raw: null,
          value: initialValueRef.current,
        };

        return initialValueRef.current;
      }

      if (snapshotRef.current?.key === key && snapshotRef.current.raw === raw) {
        return snapshotRef.current.value;
      }

      const parsed = JSON.parse(raw) as T;
      snapshotRef.current = { key, raw, value: parsed };
      return parsed;
    } catch (error) {
      console.warn(`Error reading localStorage key "${key}":`, error);
      return initialValueRef.current;
    }
  }, [key]);

  const getServerSnapshot = useCallback(() => initialValueRef.current, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setPersistedState = useCallback(
    (value: SetValue<T>) => {
      if (typeof window === "undefined" || !window.localStorage) {
        return;
      }

      try {
        const prevState = readPersistedState<T>(key, initialValueRef.current);
        const newValue = value instanceof Function ? value(prevState) : value;

        if (newValue === undefined || newValue === null) {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, JSON.stringify(newValue));
        }

        // Notify hook subscribers synchronously (keeps UI responsive).
        notifySubscribers(key, componentIdRef.current);

        // Dispatch custom event for same-tab synchronization for non-hook listeners.
        const customEvent = new CustomEvent(getStorageChangeEvent(key), {
          detail: { key, newValue, origin: componentIdRef.current },
        });
        window.dispatchEvent(customEvent);
      } catch (error) {
        console.warn(`Error writing to localStorage key "${key}":`, error);
      }
    },
    [key]
  );

  return [state, setPersistedState];
}
