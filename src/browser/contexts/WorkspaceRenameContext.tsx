import React, { createContext, useContext, useState, useCallback } from "react";

interface RenameResult {
  success: boolean;
  error?: string;
}

interface RenameContextValue {
  editingWorkspaceId: string | null;
  requestRename: (workspaceId: string, currentName: string) => boolean;
  confirmRename: (workspaceId: string, newName: string) => Promise<RenameResult>;
  cancelRename: () => void;
}

const RenameContext = createContext<RenameContextValue | null>(null);

interface RenameProviderProps {
  children: React.ReactNode;
  onRenameWorkspace: (
    workspaceId: string,
    newName: string
  ) => Promise<{ success: boolean; error?: string }>;
}

export const RenameProvider: React.FC<RenameProviderProps> = ({ children, onRenameWorkspace }) => {
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(null);
  const [originalName, setOriginalName] = useState<string>("");

  const requestRename = useCallback(
    (workspaceId: string, currentName: string): boolean => {
      // Only allow one workspace to be edited at a time
      if (editingWorkspaceId !== null && editingWorkspaceId !== workspaceId) {
        return false;
      }

      setEditingWorkspaceId(workspaceId);
      setOriginalName(currentName);
      return true;
    },
    [editingWorkspaceId]
  );

  const confirmRename = useCallback(
    async (workspaceId: string, newName: string): Promise<RenameResult> => {
      const trimmedName = newName.trim();

      // Short-circuit if name hasn't changed
      if (trimmedName === originalName) {
        setEditingWorkspaceId(null);
        setOriginalName("");
        return { success: true };
      }

      if (!trimmedName) {
        return { success: false, error: "Name cannot be empty" };
      }

      const result = await onRenameWorkspace(workspaceId, trimmedName);

      if (result.success) {
        setEditingWorkspaceId(null);
        setOriginalName("");
      }

      return result;
    },
    [originalName, onRenameWorkspace]
  );

  const cancelRename = useCallback(() => {
    setEditingWorkspaceId(null);
    setOriginalName("");
  }, []);

  const value: RenameContextValue = {
    editingWorkspaceId,
    requestRename,
    confirmRename,
    cancelRename,
  };

  return <RenameContext.Provider value={value}>{children}</RenameContext.Provider>;
};

export const useRename = (): RenameContextValue => {
  const context = useContext(RenameContext);
  if (!context) {
    throw new Error("useRename must be used within a RenameProvider");
  }
  return context;
};
