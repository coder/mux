import type { ReactNode } from "react";
import React, { createContext, useContext } from "react";
import type { ThinkingLevel } from "@/common/types/thinking";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getThinkingLevelKey, getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";

interface ThinkingContextType {
  thinkingLevel: ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
}

const ThinkingContext = createContext<ThinkingContextType | undefined>(undefined);

interface ThinkingProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

export const ThinkingProvider: React.FC<ThinkingProviderProps> = ({
  workspaceId,
  projectPath,
  children,
}) => {
  // Priority: workspace-scoped > project-scoped > global
  const scopeId = workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
  const key = getThinkingLevelKey(scopeId);
  const [thinkingLevel, setThinkingLevel] = usePersistedState<ThinkingLevel>(
    key,
    "off",
    { listener: true } // Listen for changes from command palette and other sources
  );

  return (
    <ThinkingContext.Provider value={{ thinkingLevel, setThinkingLevel }}>
      {children}
    </ThinkingContext.Provider>
  );
};

export const useThinking = () => {
  const context = useContext(ThinkingContext);
  if (!context) {
    throw new Error("useThinking must be used within a ThinkingProvider");
  }
  return context;
};
