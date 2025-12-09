import type { JSX } from "react";
import type { PropsWithChildren } from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { assert } from "../utils/assert";

export type ThinkingLevel = "off" | "low" | "medium" | "high";

interface ThinkingContextValue {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

const ThinkingContext = createContext<ThinkingContextValue | null>(null);

const STORAGE_NAMESPACE = "mux.thinking-level";

/**
 * Sanitize workspace ID to be compatible with SecureStore key requirements.
 * SecureStore keys must contain only alphanumeric characters, ".", "-", and "_".
 */
function sanitizeWorkspaceId(workspaceId: string): string {
  // Replace slashes and other invalid chars with underscores
  return workspaceId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function readThinkingLevel(storageKey: string): Promise<ThinkingLevel | null> {
  try {
    const value = await SecureStore.getItemAsync(storageKey);
    if (value === "off" || value === "low" || value === "medium" || value === "high") {
      return value;
    }
    return null;
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to read thinking level", error);
    }
    return null;
  }
}

async function writeThinkingLevel(storageKey: string, level: ThinkingLevel): Promise<void> {
  try {
    await SecureStore.setItemAsync(storageKey, level);
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("Failed to persist thinking level", error);
    }
  }
}

export interface ThinkingProviderProps extends PropsWithChildren {
  workspaceId: string;
}

export function ThinkingProvider({ workspaceId, children }: ThinkingProviderProps): JSX.Element {
  const storageKey = useMemo(
    () => `${STORAGE_NAMESPACE}.${sanitizeWorkspaceId(workspaceId)}`,
    [workspaceId]
  );
  const [thinkingLevel, setThinkingLevelState] = useState<ThinkingLevel>("off");

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const stored = await readThinkingLevel(storageKey);
      if (!cancelled && stored) {
        setThinkingLevelState(stored);
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  const setThinkingLevel = useCallback(
    (level: ThinkingLevel) => {
      setThinkingLevelState(level);
      void writeThinkingLevel(storageKey, level);
    },
    [storageKey]
  );

  return (
    <ThinkingContext.Provider value={{ thinkingLevel, setThinkingLevel }}>
      {children}
    </ThinkingContext.Provider>
  );
}

export function useThinkingLevel(): [ThinkingLevel, (level: ThinkingLevel) => void] {
  const context = useContext(ThinkingContext);
  assert(context, "useThinkingLevel must be used within a ThinkingProvider");
  return [context.thinkingLevel, context.setThinkingLevel];
}
