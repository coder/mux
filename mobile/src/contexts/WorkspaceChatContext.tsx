import type { JSX, ReactNode } from "react";
import { createContext, useCallback, useContext, useRef } from "react";
import { createChatEventExpander } from "../messages/normalizeChatEvent";
import type { ChatEventExpander } from "../messages/normalizeChatEvent";

interface WorkspaceChatContextValue {
  /**
   * Get or create a ChatEventExpander for the given workspace.
   * Processors are cached per workspaceId to preserve streaming state across navigation.
   */
  getExpander(workspaceId: string): ChatEventExpander;

  /**
   * Clear the processor for a specific workspace (e.g., when workspace is deleted).
   */
  clearExpander(workspaceId: string): void;

  /**
   * Clear all processors (e.g., on logout).
   */
  clearAll(): void;
}

const WorkspaceChatContext = createContext<WorkspaceChatContextValue | null>(null);

export function WorkspaceChatProvider({ children }: { children: ReactNode }): JSX.Element {
  // Store processors keyed by workspaceId
  // Using ref to avoid re-renders when processors are created/destroyed
  const expandersRef = useRef<Map<string, ChatEventExpander>>(new Map());

  const getExpander = useCallback((workspaceId: string): ChatEventExpander => {
    const existing = expandersRef.current.get(workspaceId);
    if (existing) {
      return existing;
    }

    // Lazy-create processor on first access
    const newExpander = createChatEventExpander();
    expandersRef.current.set(workspaceId, newExpander);
    return newExpander;
  }, []);

  const clearExpander = useCallback((workspaceId: string): void => {
    expandersRef.current.delete(workspaceId);
  }, []);

  const clearAll = useCallback((): void => {
    expandersRef.current.clear();
  }, []);

  return (
    <WorkspaceChatContext.Provider value={{ getExpander, clearExpander, clearAll }}>
      {children}
    </WorkspaceChatContext.Provider>
  );
}

export function useWorkspaceChat(): WorkspaceChatContextValue {
  const context = useContext(WorkspaceChatContext);
  if (!context) {
    throw new Error("useWorkspaceChat must be used within WorkspaceChatProvider");
  }
  return context;
}
