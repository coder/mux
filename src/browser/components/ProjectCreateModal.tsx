import React, { useState, useCallback } from "react";
import { Modal, ModalActions, CancelButton, PrimaryButton } from "./Modal";
import { DirectoryPickerModal } from "./DirectoryPickerModal";
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
  // In Electron mode, window.api exists (set by preload) and has native directory picker via ORPC
  // In browser mode, window.api doesn't exist and we use web-based DirectoryPickerModal
  const isDesktop = !!window.api;
  const hasWebFsPicker = !isDesktop;
  const [isCreating, setIsCreating] = useState(false);
  const [isDirPickerOpen, setIsDirPickerOpen] = useState(false);

  const handleCancel = useCallback(() => {
    setPath("");
    setError("");
    onClose();
  }, [onClose]);

  const handleWebPickerPathSelected = useCallback((selected: string) => {
    setPath(selected);
    setError("");
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const selectedPath = await api?.projects.pickDirectory();
      if (selectedPath) {
        setPath(selectedPath);
        setError("");
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
        setError(errorMessage);
      }
    } catch (err) {
      // Unexpected error
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      setError(`Failed to add project: ${errorMessage}`);
    } finally {
      setIsCreating(false);
    }
  }, [path, onSuccess, onClose, api]);

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

  return (
    <>
      <Modal
        isOpen={isOpen}
        title="Add Project"
        subtitle="Enter the path to your project directory"
        onClose={handleCancel}
        isLoading={isCreating}
      >
        <div className="mb-5 flex gap-2">
          <input
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError("");
            }}
            onKeyDown={handleKeyDown}
            placeholder="/home/user/projects/my-project"
            autoFocus
            disabled={isCreating}
            className="bg-modal-bg border-border-medium focus:border-accent placeholder:text-muted text-foreground min-w-0 flex-1 rounded border px-3 py-2 font-mono text-sm focus:outline-none disabled:opacity-50"
          />
          {(isDesktop || hasWebFsPicker) && (
            <button
              type="button"
              onClick={handleBrowseClick}
              disabled={isCreating}
              className="bg-modal-bg border-border-medium text-muted hover:text-foreground hover:border-accent shrink-0 rounded border px-3 py-2 text-sm transition-colors disabled:opacity-50"
            >
              Browse…
            </button>
          )}
        </div>
        {error && <div className="text-error -mt-3 mb-3 text-xs">{error}</div>}
        <ModalActions>
          <CancelButton onClick={handleCancel} disabled={isCreating}>
            Cancel
          </CancelButton>
          <PrimaryButton onClick={() => void handleSelect()} disabled={isCreating}>
            {isCreating ? "Adding..." : "Add Project"}
          </PrimaryButton>
        </ModalActions>
      </Modal>
      <DirectoryPickerModal
        isOpen={isDirPickerOpen}
        initialPath={path || "."}
        onClose={() => setIsDirPickerOpen(false)}
        onSelectPath={handleWebPickerPathSelected}
      />
    </>
  );
};
