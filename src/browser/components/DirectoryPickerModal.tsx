import React, { useCallback, useEffect, useState } from "react";
import { Modal, ModalActions, CancelButton, PrimaryButton } from "./Modal";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { DirectoryTree } from "./DirectoryTree";
import type { IPCApi } from "@/common/types/ipc";

interface DirectoryPickerModalProps {
  isOpen: boolean;
  initialPath: string;
  onClose: () => void;
  onSelectPath: (path: string) => void;
}

export const DirectoryPickerModal: React.FC<DirectoryPickerModalProps> = ({
  isOpen,
  initialPath,
  onClose,
  onSelectPath,
}) => {
  type FsListDirectoryResponse = FileTreeNode & { success?: boolean; error?: unknown };
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = useCallback(async (path: string) => {
    const api = window.api as unknown as IPCApi;
    if (!api.fs?.listDirectory) {
      setError("Directory picker is not available in this environment.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const tree = (await api.fs.listDirectory(path)) as FsListDirectoryResponse;

      // In browser/server mode, HttpIpcMainAdapter wraps handler errors as
      // { success: false, error }, and invokeIPC returns that object instead
      // of throwing. Detect that shape and surface a friendly error instead
      // of crashing when accessing tree.children.
      if (tree.success === false) {
        const errorMessage = typeof tree.error === "string" ? tree.error : "Unknown error";
        setError(`Failed to load directory: ${errorMessage}`);
        setRoot(null);
        return;
      }

      setRoot(tree);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to load directory: ${message}`);
      setRoot(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void loadDirectory(initialPath || ".");
  }, [isOpen, initialPath, loadDirectory]);

  const handleNavigateTo = useCallback(
    (path: string) => {
      void loadDirectory(path);
    },
    [loadDirectory]
  );

  const handleNavigateParent = useCallback(() => {
    if (!root) return;
    void loadDirectory(`${root.path}/..`);
  }, [loadDirectory, root]);

  const handleConfirm = useCallback(() => {
    if (!root) {
      return;
    }

    onSelectPath(root.path);
    onClose();
  }, [onClose, onSelectPath, root]);

  if (!isOpen) return null;
  const entries =
    root?.children
      .filter((child) => child.isDirectory)
      .map((child) => ({ name: child.name, path: child.path })) ?? [];

  return (
    <Modal
      isOpen={isOpen}
      title="Select Project Directory"
      subtitle={root ? root.path : "Select a directory to use as your project root"}
      onClose={onClose}
      isLoading={isLoading}
    >
      {error && <div className="text-error mb-3 text-xs">{error}</div>}
      <div className="bg-modal-bg border-border-medium mb-4 h-64 overflow-hidden rounded border">
        <DirectoryTree
          currentPath={root ? root.path : null}
          entries={entries}
          isLoading={isLoading}
          onNavigateTo={handleNavigateTo}
          onNavigateParent={handleNavigateParent}
        />
      </div>
      <ModalActions>
        <CancelButton onClick={onClose} disabled={isLoading}>
          Cancel
        </CancelButton>
        <PrimaryButton onClick={() => void handleConfirm()} disabled={isLoading || !root}>
          Select
        </PrimaryButton>
      </ModalActions>
    </Modal>
  );
};
