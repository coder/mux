import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import { Input } from "@/browser/components/ui/input";
import type { FileTreeNode } from "@/common/utils/git/numstatParser";
import { DirectoryTree } from "./DirectoryTree";
import { useAPI } from "@/browser/contexts/API";
import { formatKeybind, isMac } from "@/browser/utils/ui/keybinds";

const OPEN_KEYBIND = { key: "o", ctrl: true };

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
  const { api } = useAPI();
  const [root, setRoot] = useState<FileTreeNode | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath || "");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const treeRef = useRef<HTMLDivElement>(null);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!api) {
        setError("Not connected to server");
        return;
      }
      setIsLoading(true);
      setError(null);

      try {
        const result = await api.general.listDirectory({ path });

        if (!result.success) {
          const errorMessage = typeof result.error === "string" ? result.error : "Unknown error";
          setError(`Failed to load directory: ${errorMessage}`);
          setRoot(null);
          return;
        }

        setRoot(result.data);
        setPathInput(result.data.path);
        setSelectedIndex(0);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Failed to load directory: ${message}`);
        setRoot(null);
      } finally {
        setIsLoading(false);
      }
    },
    [api]
  );

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

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isLoading) {
        onClose();
      }
    },
    [isLoading, onClose]
  );

  const handlePathInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void loadDirectory(pathInput);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        // Focus the tree and start navigation
        const treeContainer = treeRef.current?.querySelector("[tabindex]");
        if (treeContainer instanceof HTMLElement) {
          treeContainer.focus();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key === "o") {
        e.preventDefault();
        if (!isLoading && root) {
          handleConfirm();
        }
      }
    },
    [pathInput, loadDirectory, handleConfirm, isLoading, root]
  );

  const entries =
    root?.children
      .filter((child) => child.isDirectory)
      .map((child) => ({ name: child.name, path: child.path })) ?? [];

  const shortcutLabel = isMac() ? "⌘O" : formatKeybind(OPEN_KEYBIND);

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Select Project Directory</DialogTitle>
          <DialogDescription>Navigate to select a directory for your project</DialogDescription>
        </DialogHeader>
        <div className="mb-3">
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={handlePathInputKeyDown}
            placeholder="Enter path..."
            className="bg-modal-bg border-border-medium h-9 font-mono text-sm"
          />
        </div>
        {error && <div className="text-error mb-3 text-xs">{error}</div>}
        <div
          ref={treeRef}
          className="bg-modal-bg border-border-medium mb-4 h-80 overflow-hidden rounded border"
        >
          <DirectoryTree
            currentPath={root ? root.path : null}
            entries={entries}
            isLoading={isLoading}
            onNavigateTo={handleNavigateTo}
            onNavigateParent={handleNavigateParent}
            onConfirm={handleConfirm}
            selectedIndex={selectedIndex}
            onSelectedIndexChange={setSelectedIndex}
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={isLoading || !root}
            title={`Open folder (${shortcutLabel})`}
          >
            Open ({shortcutLabel})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
