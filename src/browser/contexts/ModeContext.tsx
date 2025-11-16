import type { ReactNode } from "react";
import React, { createContext, useContext, useEffect } from "react";
import type { UIMode } from "@/common/types/mode";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { matchesKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { getModeKey, getProjectScopeId, GLOBAL_SCOPE_ID } from "@/common/constants/storage";

type ModeContextType = [UIMode, (mode: UIMode) => void];

const ModeContext = createContext<ModeContextType | undefined>(undefined);

interface ModeProviderProps {
  workspaceId?: string; // Workspace-scoped storage (highest priority)
  projectPath?: string; // Project-scoped storage (fallback if no workspaceId)
  children: ReactNode;
}

export const ModeProvider: React.FC<ModeProviderProps> = ({
  workspaceId,
  projectPath,
  children,
}) => {
  // Priority: workspace-scoped > project-scoped > global
  const scopeId = workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
  const modeKey = getModeKey(scopeId);
  const [mode, setMode] = usePersistedState<UIMode>(modeKey, "exec", {
    listener: true, // Listen for changes from command palette and other sources
  });

  // Set up global keybind handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (matchesKeybind(e, KEYBINDS.TOGGLE_MODE)) {
        e.preventDefault();
        setMode((currentMode) => (currentMode === "plan" ? "exec" : "plan"));
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setMode]);

  const value: ModeContextType = [mode, setMode];

  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
};

export const useMode = (): ModeContextType => {
  const context = useContext(ModeContext);
  if (!context) {
    throw new Error("useMode must be used within a ModeProvider");
  }
  return context;
};
