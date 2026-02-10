import React, { useState, useCallback, useEffect, useImperativeHandle } from "react";
import { FolderOpen, Github } from "lucide-react";
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
import { ToggleGroup, ToggleGroupItem } from "@/browser/components/ui/toggle-group";
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

// Keep the existing path-based add flow unchanged while adding clone as an alternate mode.
type ProjectCreateMode = "pick-folder" | "clone";

interface ProjectCloneFormProps {
  onSuccess: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  onClose: () => void;
  isOpen: boolean;
  defaultCloneDir: string;
  onIsCreatingChange?: (isCreating: boolean) => void;
}

function getRepoNameFromUrl(repoUrl: string): string {
  const normalizedRepoUrl = repoUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  if (!normalizedRepoUrl) {
    return "";
  }

  const withoutGitSuffix = normalizedRepoUrl.replace(/\.git$/, "");
  const segments = withoutGitSuffix.split(/[/:]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function buildCloneDestinationPreview(cloneParentDir: string, repoName: string): string {
  if (!repoName) {
    return "";
  }

  const trimmedCloneParentDir = cloneParentDir.trim();
  if (!trimmedCloneParentDir) {
    return "";
  }

  const normalizedCloneParentDir = trimmedCloneParentDir.replace(/[\\/]+$/, "");
  const separator =
    normalizedCloneParentDir.includes("\\") && !normalizedCloneParentDir.includes("/") ? "\\" : "/";

  return `${normalizedCloneParentDir}${separator}${repoName}`;
}

function ProjectCloneForm(props: ProjectCloneFormProps) {
  const { api } = useAPI();
  const [repoUrl, setRepoUrl] = useState("");
  const [cloneParentDir, setCloneParentDir] = useState(props.defaultCloneDir);
  const [hasEditedCloneParentDir, setHasEditedCloneParentDir] = useState(false);
  const [error, setError] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isDirPickerOpen, setIsDirPickerOpen] = useState(false);
  const isDesktop = !!window.api;
  const hasWebFsPicker = !isDesktop;

  const setCreating = useCallback(
    (next: boolean) => {
      setIsCreating(next);
      props.onIsCreatingChange?.(next);
    },
    [props]
  );

  const reset = useCallback(() => {
    setRepoUrl("");
    setCloneParentDir(props.defaultCloneDir);
    setHasEditedCloneParentDir(false);
    setError("");
  }, [props.defaultCloneDir]);

  useEffect(() => {
    if (!props.isOpen) {
      reset();
    }
  }, [props.isOpen, reset]);

  useEffect(() => {
    if (!props.isOpen || hasEditedCloneParentDir) {
      return;
    }

    setCloneParentDir(props.defaultCloneDir);
  }, [props.defaultCloneDir, props.isOpen, hasEditedCloneParentDir]);

  const trimmedCloneParentDir = cloneParentDir.trim();

  const handleCancel = useCallback(() => {
    reset();
    props.onClose();
  }, [props, reset]);

  const handleWebPickerPathSelected = useCallback((selectedPath: string) => {
    setCloneParentDir(selectedPath);
    setHasEditedCloneParentDir(true);
    setError("");
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const selectedPath = await api?.projects.pickDirectory();
      if (selectedPath) {
        setCloneParentDir(selectedPath);
        setHasEditedCloneParentDir(true);
        setError("");
      }
    } catch (err) {
      console.error("Failed to pick clone directory:", err);
    }
  }, [api]);

  const handleBrowseClick = useCallback(() => {
    if (isDesktop) {
      void handleBrowse();
      return;
    }

    if (hasWebFsPicker) {
      setIsDirPickerOpen(true);
    }
  }, [handleBrowse, hasWebFsPicker, isDesktop]);

  const handleClone = useCallback(async (): Promise<boolean> => {
    const trimmedRepoUrl = repoUrl.trim();
    if (!trimmedRepoUrl) {
      setError("Please enter a repository URL");
      return false;
    }

    if (isCreating) {
      return false;
    }

    if (!api) {
      setError("Not connected to server");
      return false;
    }

    setError("");
    setCreating(true);

    try {
      const result = await api.projects.clone({
        repoUrl: trimmedRepoUrl,
        cloneParentDir: trimmedCloneParentDir || undefined,
      });

      if (result.success) {
        const { normalizedPath, projectConfig } = result.data;
        props.onSuccess(normalizedPath, projectConfig);
        reset();
        props.onClose();
        return true;
      }

      const errorMessage =
        typeof result.error === "string" ? result.error : "Failed to clone project";
      setError(errorMessage);
      return false;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
      setError(`Failed to clone project: ${errorMessage}`);
      return false;
    } finally {
      setCreating(false);
    }
  }, [api, isCreating, props, repoUrl, reset, setCreating, trimmedCloneParentDir]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleClone();
      }
    },
    [handleClone]
  );

  const repoName = getRepoNameFromUrl(repoUrl);
  const destinationPreview = buildCloneDestinationPreview(cloneParentDir, repoName);

  return (
    <>
      <div className="mb-3 space-y-3">
        <div className="space-y-1">
          <label className="text-muted text-xs">Repo URL</label>
          <input
            type="text"
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              setError("");
            }}
            onKeyDown={handleKeyDown}
            placeholder="owner/repo or https://github.com/..."
            autoFocus={true}
            disabled={isCreating}
            className="border-border-medium bg-modal-bg text-foreground placeholder:text-muted focus:border-accent w-full rounded border px-3 py-2 font-mono text-sm focus:outline-none disabled:opacity-50"
          />
        </div>

        <div className="space-y-1">
          <label className="text-muted text-xs">Location</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={cloneParentDir}
              onChange={(e) => {
                const nextCloneParentDir = e.target.value;
                setCloneParentDir(nextCloneParentDir);
                setHasEditedCloneParentDir(true);
                setError("");
              }}
              onKeyDown={handleKeyDown}
              placeholder={props.defaultCloneDir || "Select clone location"}
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
        </div>

        {repoName && destinationPreview && (
          <p className="text-muted text-xs">
            Will clone to <span className="text-foreground font-mono">{destinationPreview}</span>
          </p>
        )}

        <p className="text-muted text-xs">
          Default location can be changed in <span className="text-foreground">Settings</span>.
        </p>
      </div>

      {error && <p className="text-error text-xs">{error}</p>}

      <DialogFooter>
        <Button variant="secondary" onClick={handleCancel} disabled={isCreating}>
          Cancel
        </Button>
        <Button onClick={() => void handleClone()} disabled={isCreating}>
          {isCreating ? "Cloning..." : "Clone Project"}
        </Button>
      </DialogFooter>

      <DirectoryPickerModal
        isOpen={isDirPickerOpen}
        initialPath={cloneParentDir || props.defaultCloneDir || "~"}
        onClose={() => setIsDirPickerOpen(false)}
        onSelectPath={handleWebPickerPathSelected}
      />
    </>
  );
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
  const [mode, setMode] = useState<ProjectCreateMode>("pick-folder");
  const [isCreating, setIsCreating] = useState(false);
  const [defaultCloneDir, setDefaultCloneDir] = useState("");
  const [isLoadingDefaultCloneDir, setIsLoadingDefaultCloneDir] = useState(false);
  const [hasLoadedDefaultCloneDir, setHasLoadedDefaultCloneDir] = useState(false);

  // Preload the clone destination default so clone mode opens with a usable location.
  const ensureDefaultCloneDir = useCallback(async () => {
    if (!api || isLoadingDefaultCloneDir || hasLoadedDefaultCloneDir) {
      return;
    }

    setIsLoadingDefaultCloneDir(true);

    try {
      const cloneDir = await api.projects.getDefaultCloneDir();
      setDefaultCloneDir(cloneDir);
      setHasLoadedDefaultCloneDir(true);
    } catch (err) {
      console.error("Failed to fetch default clone directory:", err);
    } finally {
      setIsLoadingDefaultCloneDir(false);
    }
  }, [api, hasLoadedDefaultCloneDir, isLoadingDefaultCloneDir]);

  useEffect(() => {
    if (!isOpen) {
      setMode("pick-folder");
      setIsCreating(false);
      setDefaultCloneDir("");
      setHasLoadedDefaultCloneDir(false);
      setIsLoadingDefaultCloneDir(false);
      return;
    }

    void ensureDefaultCloneDir();
  }, [ensureDefaultCloneDir, isOpen]);

  useEffect(() => {
    if (!isOpen || mode !== "clone") {
      return;
    }

    void ensureDefaultCloneDir();
  }, [ensureDefaultCloneDir, isOpen, mode]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open && !isCreating) {
        onClose();
      }
    },
    [isCreating, onClose]
  );

  const handleModeChange = useCallback(
    (nextMode: string) => {
      if (nextMode !== "pick-folder" && nextMode !== "clone") {
        return;
      }

      setMode(nextMode);
      if (nextMode === "clone") {
        void ensureDefaultCloneDir();
      }
    },
    [ensureDefaultCloneDir]
  );

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add Project</DialogTitle>
          <DialogDescription>Pick a folder or clone a project repository</DialogDescription>
        </DialogHeader>

        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={handleModeChange}
          disabled={isCreating}
          className="mb-3 h-9"
        >
          <ToggleGroupItem value="pick-folder" size="sm" className="h-7 px-3 text-[13px]">
            <FolderOpen className="h-3.5 w-3.5" />
            Local folder
          </ToggleGroupItem>
          <ToggleGroupItem value="clone" size="sm" className="h-7 px-3 text-[13px]">
            <Github className="h-3.5 w-3.5" />
            Clone repo
          </ToggleGroupItem>
        </ToggleGroup>

        {mode === "pick-folder" ? (
          <ProjectCreateForm
            onSuccess={onSuccess}
            onClose={onClose}
            showCancelButton={true}
            autoFocus={true}
            onIsCreatingChange={setIsCreating}
          />
        ) : (
          <ProjectCloneForm
            onSuccess={onSuccess}
            onClose={onClose}
            isOpen={isOpen}
            defaultCloneDir={defaultCloneDir}
            onIsCreatingChange={setIsCreating}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};
