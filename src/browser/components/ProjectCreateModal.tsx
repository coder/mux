import React, { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { DirectoryPickerModal } from "./DirectoryPickerModal";
import { Button } from "@/browser/components/ui/button";
import type { ProjectConfig } from "@/node/config";
import { useAPI } from "@/browser/contexts/API";

interface ProjectCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (normalizedPath: string, projectConfig: ProjectConfig) => void;
}

/**
 * Project creation modal that handles the full flow from path input to backend validation.
 *
 * Displays a modal for path input, calls the backend to create the project, and shows
 * validation errors inline. Modal stays open until project is successfully created or user cancels.
 */
export const ProjectCreateModal: React.FC<ProjectCreateModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const { api } = useAPI();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  // Track if the error is specifically "path does not exist" so we can offer to create it
  const [canCreateFolder, setCanCreateFolder] = useState(false);
  // In Electron mode, window.api exists (set by preload) and has native directory picker via ORPC
  // In browser mode, window.api doesn't exist and we use web-based DirectoryPickerModal
  const isDesktop = !!window.api;
  const hasWebFsPicker = !isDesktop;
  const [isCreating, setIsCreating] = useState(false);
  const [isDirPickerOpen, setIsDirPickerOpen] = useState(false);

  const handleCancel = useCallback(() => {
    setPath("");
    setError("");
    setCanCreateFolder(false);
    onClose();
  }, [onClose]);

  const handleWebPickerPathSelected = useCallback((selected: string) => {
    setPath(selected);
    setError("");
    setCanCreateFolder(false);
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const selectedPath = await api?.projects.pickDirectory();
      if (selectedPath) {
        setPath(selectedPath);
        setError("");
        setCanCreateFolder(false);
      }
    } catch (err) {
      console.error("Failed to pick directory:", err);
    }
  }, [api]);

  const handleSelect = useCallback(async () => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      setError("Please enter a directory path");
      return;
    }

    setError("");
    setCanCreateFolder(false);
    if (!api) {
      setError("Not connected to server");
      return;
    }
    setIsCreating(true);

    try {
      // First check if project already exists
      const existingProjects = await api.projects.list();
      const existingPaths = new Map(existingProjects);

      // Try to create the project
      const result = await api.projects.create({ projectPath: trimmedPath });

      if (result.success) {
        // Check if duplicate (backend may normalize the path)
        const { normalizedPath, projectConfig } = result.data;
        if (existingPaths.has(normalizedPath)) {
          setError("This project has already been added.");
          return;
        }

        // Success - notify parent and close
        onSuccess(normalizedPath, projectConfig);
        setPath("");
        setError("");
        onClose();
      } else {
        // Backend validation error - show inline, keep modal open
        const errorMessage =
          typeof result.error === "string" ? result.error : "Failed to add project";
        // Detect "Path does not exist" error to offer folder creation
        if (errorMessage.includes("Path does not exist")) {
          setCanCreateFolder(true);
          setError("This folder doesn't exist.");
        } else {
          setError(errorMessage);
        }
      }
    } catch (err) {
      // Unexpected error
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      setError(`Failed to add project: ${errorMessage}`);
    } finally {
      setIsCreating(false);
    }
  }, [path, onSuccess, onClose, api]);

  const handleCreateFolder = useCallback(async () => {
    const trimmedPath = path.trim();
    if (!trimmedPath || !api) return;

    setIsCreating(true);
    setError("");

    try {
      const createResult = await api.general.createDirectory({ path: trimmedPath });
      if (!createResult.success) {
        setError(createResult.error ?? "Failed to create folder");
        setCanCreateFolder(false);
        setIsCreating(false);
        return;
      }
      // Folder created - now retry adding the project (handleSelect manages isCreating)
      setCanCreateFolder(false);
      await handleSelect();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      setError(`Failed to create folder: ${errorMessage}`);
      setCanCreateFolder(false);
      setIsCreating(false);
    }
  }, [path, api, handleSelect]);

  const handleBrowseClick = useCallback(() => {
    if (isDesktop) {
      void handleBrowse();
    } else if (hasWebFsPicker) {
      setIsDirPickerOpen(true);
    }
  }, [handleBrowse, hasWebFsPicker, isDesktop]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSelect();
      }
    },
    [handleSelect]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isCreating) {
        handleCancel();
      }
    },
    [isCreating, handleCancel]
  );

  return (
    <>
      <Dialog open={isOpen} onOpenChange={handleOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Add Project</DialogTitle>
            <DialogDescription>Enter the path to your project directory</DialogDescription>
          </DialogHeader>
          <div className="mb-1 flex gap-2">
            <input
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setError("");
                setCanCreateFolder(false);
              }}
              onKeyDown={handleKeyDown}
              placeholder="/home/user/projects/my-project"
              autoFocus
              disabled={isCreating}
              className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-muted text-foreground min-w-0 flex-1 rounded border px-3 py-2 font-mono text-sm focus:outline-none disabled:opacity-50"
            />
            {(isDesktop || hasWebFsPicker) && (
              <Button
                variant="outline"
                onClick={handleBrowseClick}
                disabled={isCreating}
                className="shrink-0"
              >
                Browse…
              </Button>
            )}
          </div>
          {error && (
            <div className="flex items-center gap-2 text-xs">
              <span className={canCreateFolder ? "text-muted" : "text-error"}>{error}</span>
              {canCreateFolder && (
                <Button
                  size="sm"
                  onClick={() => void handleCreateFolder()}
                  disabled={isCreating}
                  className="h-6 px-2 py-0 text-xs"
                >
                  Create Folder
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancel} disabled={isCreating}>
              Cancel
            </Button>
            <Button onClick={() => void handleSelect()} disabled={isCreating || canCreateFolder}>
              {isCreating ? "Adding..." : "Add Project"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DirectoryPickerModal
        isOpen={isDirPickerOpen}
        initialPath={path || "~"}
        onClose={() => setIsDirPickerOpen(false)}
        onSelectPath={handleWebPickerPathSelected}
      />
    </>
  );
};
