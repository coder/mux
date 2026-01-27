import React, { useState, useCallback, useImperativeHandle } from "react";
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

interface ProjectCreateFormProps {
  onSuccess: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  /**
   * Optional close handler for modal-style usage.
   * When provided, the form will call it on cancel and after a successful add.
   */
  onClose?: () => void;
  /** Show a cancel button (default: false). */
  showCancelButton?: boolean;
  /** Auto-focus the path input (default: false). */
  autoFocus?: boolean;
  /** Optional hook for parent components to gate closing while requests are in-flight. */
  onIsCreatingChange?: (isCreating: boolean) => void;
  /** Optional override for the submit button label (default: "Add Project"). */
  submitLabel?: string;
  /** Optional override for the path placeholder. */
  placeholder?: string;
  /** Hide the footer actions (submit/cancel buttons). */
  hideFooter?: boolean;
}

export interface ProjectCreateFormHandle {
  submit: () => Promise<boolean>;
  getTrimmedPath: () => string;
}

export const ProjectCreateForm = React.forwardRef<ProjectCreateFormHandle, ProjectCreateFormProps>(
  function ProjectCreateForm(
    {
      onSuccess,
      onClose,
      showCancelButton = false,
      autoFocus = false,
      onIsCreatingChange,
      submitLabel = "Add Project",
      placeholder = window.api?.platform === "win32"
        ? "C:\\Users\\user\\projects\\my-project"
        : "/home/user/projects/my-project",
      hideFooter = false,
    },
    ref
  ) {
    const { api } = useAPI();
    const [path, setPath] = useState("");
    const [error, setError] = useState("");
    // In Electron mode, window.api exists (set by preload) and has native directory picker via ORPC
    // In browser mode, window.api doesn't exist and we use web-based DirectoryPickerModal
    const isDesktop = !!window.api;
    const hasWebFsPicker = !isDesktop;
    const [isCreating, setIsCreating] = useState(false);
    const [isDirPickerOpen, setIsDirPickerOpen] = useState(false);

    const setCreating = useCallback(
      (next: boolean) => {
        setIsCreating(next);
        onIsCreatingChange?.(next);
      },
      [onIsCreatingChange]
    );

    const reset = useCallback(() => {
      setPath("");
      setError("");
    }, []);

    const handleCancel = useCallback(() => {
      reset();
      onClose?.();
    }, [onClose, reset]);

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

    const handleSelect = useCallback(async (): Promise<boolean> => {
      const trimmedPath = path.trim();
      if (!trimmedPath) {
        setError("Please enter a project name or path");
        return false;
      }

      if (isCreating) {
        return false;
      }

      setError("");
      if (!api) {
        setError("Not connected to server");
        return false;
      }
      setCreating(true);

      try {
        // First check if project already exists
        const existingProjects = await api.projects.list();
        const existingPaths = new Map(existingProjects);

        // Backend handles path resolution (bare names → ~/.mux/projects/name)
        const result = await api.projects.create({ projectPath: trimmedPath });

        if (result.success) {
          // Check if duplicate (backend may normalize the path)
          const { normalizedPath, projectConfig } = result.data;
          if (existingPaths.has(normalizedPath)) {
            setError("This project has already been added.");
            return false;
          }

          onSuccess(normalizedPath, projectConfig);
          reset();
          onClose?.();
          return true;
        }

        // Backend validation error - show inline
        const errorMessage =
          typeof result.error === "string" ? result.error : "Failed to add project";
        setError(errorMessage);
        return false;
      } catch (err) {
        // Unexpected error
        const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
        setError(`Failed to add project: ${errorMessage}`);
        return false;
      } finally {
        setCreating(false);
      }
    }, [api, isCreating, onClose, onSuccess, path, reset, setCreating]);

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

    useImperativeHandle(
      ref,
      () => ({
        submit: handleSelect,
        getTrimmedPath: () => path.trim(),
      }),
      [handleSelect, path]
    );

    return (
      <>
        <div className="mb-1 flex gap-2">
          <input
            type="text"
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setError("");
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            autoFocus={autoFocus}
            disabled={isCreating}
            className="border-border-medium bg-modal-bg text-foreground placeholder:text-muted focus:border-accent min-w-0 flex-1 rounded border px-3 py-2 font-mono text-sm focus:outline-none disabled:opacity-50"
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

        {error && <p className="text-error text-xs">{error}</p>}

        {!hideFooter && (
          <DialogFooter>
            {showCancelButton && (
              <Button variant="secondary" onClick={handleCancel} disabled={isCreating}>
                Cancel
              </Button>
            )}
            <Button onClick={() => void handleSelect()} disabled={isCreating}>
              {isCreating ? "Adding..." : submitLabel}
            </Button>
          </DialogFooter>
        )}

        <DirectoryPickerModal
          isOpen={isDirPickerOpen}
          initialPath={path || "~"}
          onClose={() => setIsDirPickerOpen(false)}
          onSelectPath={handleWebPickerPathSelected}
        />
      </>
    );
  }
);

ProjectCreateForm.displayName = "ProjectCreateForm";

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
  const [isCreating, setIsCreating] = useState(false);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isCreating) {
        onClose();
      }
    },
    [isCreating, onClose]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>Enter the path to your project directory</DialogDescription>
        </DialogHeader>

        <ProjectCreateForm
          onSuccess={onSuccess}
          onClose={onClose}
          showCancelButton={true}
          autoFocus={true}
          onIsCreatingChange={setIsCreating}
        />
      </DialogContent>
    </Dialog>
  );
};
