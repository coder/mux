import React, { createContext, useContext, useCallback, useState } from "react";

interface WorkspaceActionsContextType {
  todoCardVisible: boolean;
  toggleTodoCard: () => void;
  hasTodos: boolean;
  setHasTodos: (has: boolean) => void;
}

const WorkspaceActionsContext = createContext<WorkspaceActionsContextType | null>(null);

export function WorkspaceActionsProvider({ children }: { children: React.ReactNode }) {
  const [todoCardVisible, setTodoCardVisible] = useState(false);
  const [hasTodos, setHasTodos] = useState(false);

  const toggleTodoCard = useCallback(() => {
    setTodoCardVisible((prev) => !prev);
  }, []);

  return (
    <WorkspaceActionsContext.Provider
      value={{ todoCardVisible, toggleTodoCard, hasTodos, setHasTodos }}
    >
      {children}
    </WorkspaceActionsContext.Provider>
  );
}

export function useWorkspaceActions() {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("useWorkspaceActions must be used within WorkspaceActionsProvider");
  }
  return context;
}
