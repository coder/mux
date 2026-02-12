import React, { createContext, useContext, useState, useCallback } from "react";

interface TitleEditResult {
  success: boolean;
  error?: string;
}

interface TitleEditContextValue {
  editingWorkspaceId: string | null;
  requestEdit: (workspaceId: string, currentTitle: string) => boolean;
  confirmEdit: (workspaceId: string, newTitle: string) => Promise<TitleEditResult>;
  cancelEdit: () => void;
}

const TitleEditContext = createContext<TitleEditContextValue | null>(null);

interface TitleEditProviderProps {
  children: React.ReactNode;
  onUpdateTitle: (
    workspaceId: string,
    newTitle: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export const TitleEditProvider: React.FC<TitleEditProviderProps> = ({
  children,
  onUpdateTitle,
}) => {
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [originalTitle, setOriginalTitle] = useState<string>("");

  const requestEdit = useCallback(
    (workspaceId: string, currentTitle: string): boolean => {
      // Only allow one workspace to be edited at a time
      if (editingWorkspaceId !== null && editingWorkspaceId !== workspaceId) {
        return false;
      }

      setEditingWorkspaceId(workspaceId);
      setOriginalTitle(currentTitle);
      return true;
    },
    [editingWorkspaceId]
  );

  const confirmEdit = useCallback(
    async (workspaceId: string, newTitle: string): Promise<TitleEditResult> => {
      const trimmedTitle = newTitle.trim();

      // Short-circuit if title hasn't changed
      if (trimmedTitle === originalTitle) {
        setEditingWorkspaceId(null);
        setOriginalTitle("");
        return { success: true };
      }

      if (!trimmedTitle) {
        return { success: false, error: "Title cannot be empty" };
      }

      const result = await onUpdateTitle(workspaceId, trimmedTitle);

      if (result.success) {
        setEditingWorkspaceId(null);
        setOriginalTitle("");
      }

      return result;
    },
    [originalTitle, onUpdateTitle]
  );

  const cancelEdit = useCallback(() => {
    setEditingWorkspaceId(null);
    setOriginalTitle("");
  }, []);

  const value: TitleEditContextValue = {
    editingWorkspaceId,
    requestEdit,
    confirmEdit,
    cancelEdit,
  };

  return <TitleEditContext.Provider value={value}>{children}</TitleEditContext.Provider>;
};

export const useTitleEdit = (): TitleEditContextValue => {
  const context = useContext(TitleEditContext);
  if (!context) {
    throw new Error("useTitleEdit must be used within a TitleEditProvider");
  }
  return context;
};
