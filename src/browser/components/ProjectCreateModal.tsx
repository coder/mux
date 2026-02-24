import React, { useState, useCallback, useEffect, useImperativeHandle, useRef } from "react";
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

type ApiClient = ReturnType<typeof useAPI>["api"];

function useDirectoryPicker(params: {
  api: ApiClient;
  initialPath: string;
  onSelectPath: (path: string) => void;
  errorLabel: string;
}) {
  const { api, initialPath, onSelectPath, errorLabel } = params;
  const isDesktop = !!window.api;
  const hasWebFsPicker = !isDesktop;
  const [isDirPickerOpen, setIsDirPickerOpen] = useState(false);

  const handleWebPickerPathSelected = useCallback(
    (selected: string) => {
      onSelectPath(selected);
    },
    [onSelectPath]
  );

  const browse = useCallback(async () => {
    if (isDesktop) {
      try {
        const selectedPath = await api?.projects.pickDirectory();
        if (selectedPath) {
          onSelectPath(selectedPath);
        }
      } catch (err) {
        console.error(errorLabel, err);
      }
      return;
    }

    if (hasWebFsPicker) {
      setIsDirPickerOpen(true);
    }
  }, [api, errorLabel, hasWebFsPicker, isDesktop, onSelectPath]);

  const directoryPickerModal = hasWebFsPicker ? (
    <DirectoryPickerModal
      isOpen={isDirPickerOpen}
      initialPath={initialPath || "~"}
      onClose={() => setIsDirPickerOpen(false)}
      onSelectPath={handleWebPickerPathSelected}
    />
  ) : null;

  return { canBrowse: isDesktop || hasWebFsPicker, browse, directoryPickerModal };
}

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
    const [isCreating, setIsCreating] = useState(false);

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

    const { canBrowse, browse, directoryPickerModal } = useDirectoryPicker({
      api,
      initialPath: path || "~",
      onSelectPath: (selectedPath) => {
        setPath(selectedPath);
        setError("");
      },
      errorLabel: "Failed to pick directory:",
    });

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
        <div className="space-y-1">
          <label className="text-muted text-xs">Path</label>
          <div className="flex gap-2">
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
            {canBrowse && (
              <Button
                variant="outline"
                onClick={() => void browse()}
                disabled={isCreating}
                className="shrink-0"
              >
                Browse…
              </Button>
            )}
          </div>
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

        {directoryPickerModal}
      </>
    );
  }
);

ProjectCreateForm.displayName = "ProjectCreateForm";

// Keep the existing path-based add flow unchanged while adding clone as an alternate mode.
export type ProjectCreateMode = "pick-folder" | "clone";

interface ProjectCloneFormProps {
  onSuccess: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  onClose?: () => void;
  isOpen: boolean;
  defaultProjectDir: string;
  onIsCreatingChange?: (isCreating: boolean) => void;
  hideFooter?: boolean;
  autoFocus?: boolean;
}

export interface ProjectCloneFormHandle {
  submit: () => Promise<boolean>;
  getTrimmedRepoUrl: () => string;
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

function formatCloneError(event: { code: string; error: string }): string {
  switch (event.code) {
    case "ssh_host_key_rejected":
      return "SSH host key was rejected. The clone was cancelled.";
    case "ssh_credential_cancelled":
      return "SSH authentication was cancelled.";
    case "ssh_prompt_timeout":
      return "SSH authentication timed out.";
    default:
      return event.error || "Failed to clone project";
  }
}

/**
 * Simulate terminal carriage-return handling: for each line, only the
 * text after the last \r is visible (earlier content is "overwritten").
 */
function processTerminalOutput(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const segments = line.split("\r");
      // When a chunk ends with \r, the last segment is empty — use the
      // last non-empty segment so in-flight progress lines stay visible.
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i] !== "") return segments[i];
      }
      return "";
    })
    .join("\n");
}

const ProjectCloneForm = React.forwardRef<ProjectCloneFormHandle, ProjectCloneFormProps>(
  function ProjectCloneForm(props, ref) {
    const { api } = useAPI();
    const [repoUrl, setRepoUrl] = useState("");
    const [cloneParentDir, setCloneParentDir] = useState(props.defaultProjectDir);
    const [hasEditedCloneParentDir, setHasEditedCloneParentDir] = useState(false);
    const [error, setError] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [cloneOutput, setCloneOutput] = useState("");
    const rawOutputRef = useRef("");
    const abortControllerRef = useRef<AbortController | null>(null);
    const progressEndRef = useRef<HTMLDivElement | null>(null);

    const setCreating = useCallback(
      (next: boolean) => {
        setIsCreating(next);
        props.onIsCreatingChange?.(next);
      },
      [props]
    );

    const reset = useCallback(() => {
      setRepoUrl("");
      setCloneParentDir(props.defaultProjectDir);
      setHasEditedCloneParentDir(false);
      setError("");
      setCloneOutput("");
      rawOutputRef.current = "";
    }, [props.defaultProjectDir]);

    const abortInFlightClone = useCallback(() => {
      if (!abortControllerRef.current) {
        return;
      }

      abortControllerRef.current.abort();
    }, []);

    useEffect(() => {
      if (!props.isOpen) {
        abortInFlightClone();
        reset();
      }
    }, [abortInFlightClone, props.isOpen, reset]);

    useEffect(() => abortInFlightClone, [abortInFlightClone]);

    useEffect(() => {
      if (!props.isOpen || hasEditedCloneParentDir) {
        return;
      }

      setCloneParentDir(props.defaultProjectDir);
    }, [props.defaultProjectDir, props.isOpen, hasEditedCloneParentDir]);

    useEffect(() => {
      progressEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [cloneOutput]);

    const trimmedCloneParentDir = cloneParentDir.trim();

    const handleCancel = useCallback(() => {
      abortInFlightClone();
      reset();
      props.onClose?.();
    }, [abortInFlightClone, props, reset]);

    const { canBrowse, browse, directoryPickerModal } = useDirectoryPicker({
      api,
      initialPath: cloneParentDir || props.defaultProjectDir || "~",
      onSelectPath: (selectedPath) => {
        setCloneParentDir(selectedPath);
        setHasEditedCloneParentDir(true);
        setError("");
      },
      errorLabel: "Failed to pick clone directory:",
    });

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
      setCloneOutput("");
      rawOutputRef.current = "";
      setCreating(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const cloneEvents = await api.projects.clone(
          {
            repoUrl: trimmedRepoUrl,
            cloneParentDir: trimmedCloneParentDir || undefined,
          },
          { signal: controller.signal }
        );

        for await (const event of cloneEvents) {
          if (event.type === "progress") {
            if (!controller.signal.aborted) {
              // Show clone stderr in a terminal-like way so carriage returns replace prior progress lines.
              rawOutputRef.current += event.line;
              setCloneOutput(processTerminalOutput(rawOutputRef.current));
            }
            continue;
          }

          if (event.type === "success") {
            const { normalizedPath, projectConfig } = event;
            props.onSuccess(normalizedPath, projectConfig);
            reset();
            props.onClose?.();
            return true;
          }

          setError(formatCloneError(event));
          return false;
        }

        if (controller.signal.aborted) {
          setError("Clone cancelled");
          return false;
        }

        setError("Clone did not return a completion event");
        return false;
      } catch (err) {
        if (controller.signal.aborted) {
          setError("Clone cancelled");
          return false;
        }

        const errorMessage = err instanceof Error ? err.message : "An unexpected error occurred";
        setError(`Failed to clone project: ${errorMessage}`);
        return false;
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
          setCreating(false);
        }
      }
    }, [api, isCreating, props, repoUrl, reset, setCreating, trimmedCloneParentDir]);

    const handleRetry = useCallback(() => {
      setError("");
      setCloneOutput("");
      rawOutputRef.current = "";
    }, []);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void handleClone();
        }
      },
      [handleClone]
    );

    useImperativeHandle(
      ref,
      () => ({
        submit: handleClone,
        getTrimmedRepoUrl: () => repoUrl.trim(),
      }),
      [handleClone, repoUrl]
    );

    const repoName = getRepoNameFromUrl(repoUrl);
    const destinationPreview = buildCloneDestinationPreview(cloneParentDir, repoName);
    // Keep the progress log visible after failed clones so users can diagnose the git error before retrying.
    const hasCloneFailure = !isCreating && cloneOutput.length > 0 && error.length > 0;
    const showCloneProgress = isCreating || (hasCloneFailure && !props.hideFooter);

    return (
      <>
        {showCloneProgress ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-muted text-xs">
                {hasCloneFailure ? "Clone failed" : "Cloning repository…"}
              </label>
              <div className="bg-modal-bg border-border-medium max-h-40 overflow-y-auto rounded border p-3">
                <pre className="text-muted font-mono text-xs break-all whitespace-pre-wrap">
                  {cloneOutput.length > 0 ? cloneOutput : "Starting clone…"}
                </pre>
                <div ref={progressEndRef} />
              </div>
            </div>

            {destinationPreview && (
              <p className="text-muted text-xs">
                Cloning to <span className="text-foreground font-mono">{destinationPreview}</span>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-3">
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
                autoFocus={props.autoFocus ?? true}
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
                  placeholder={props.defaultProjectDir || "Select clone location"}
                  disabled={isCreating}
                  className="border-border-medium bg-modal-bg text-foreground placeholder:text-muted focus:border-accent min-w-0 flex-1 rounded border px-3 py-2 font-mono text-sm focus:outline-none disabled:opacity-50"
                />
                {canBrowse && (
                  <Button
                    variant="outline"
                    onClick={() => void browse()}
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
                Will clone to{" "}
                <span className="text-foreground font-mono">{destinationPreview}</span>
              </p>
            )}
          </div>
        )}

        {error && <p className="text-error text-xs">{error}</p>}

        {!props.hideFooter && (
          <DialogFooter>
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            {!isCreating && (
              <Button onClick={hasCloneFailure ? handleRetry : () => void handleClone()}>
                {hasCloneFailure ? "Back to form" : "Clone Project"}
              </Button>
            )}
          </DialogFooter>
        )}

        {directoryPickerModal}
      </>
    );
  }
);

ProjectCloneForm.displayName = "ProjectCloneForm";

const NOOP = (): void => undefined;

/** Shared footer for ProjectAddForm — rendered outside the space-y-3 wrapper
 *  so it sits as a direct DialogContent grid child, aligned with the header. */
function ProjectAddFormFooter(props: {
  mode: ProjectCreateMode;
  isCreating: boolean;
  showCancelButton: boolean;
  createFormRef: React.RefObject<ProjectCreateFormHandle | null>;
  cloneFormRef: React.RefObject<ProjectCloneFormHandle | null>;
  onClose?: () => void;
}) {
  const handleSubmit = () => {
    if (props.mode === "pick-folder") {
      void props.createFormRef.current?.submit();
    } else {
      void props.cloneFormRef.current?.submit();
    }
  };

  const actionLabel = props.mode === "pick-folder" ? "Add Project" : "Clone Project";

  return (
    <DialogFooter className={props.showCancelButton ? "justify-between" : undefined}>
      {props.showCancelButton && (
        <Button variant="secondary" onClick={props.onClose} disabled={props.isCreating}>
          Cancel
        </Button>
      )}
      <Button onClick={handleSubmit} disabled={props.isCreating}>
        {props.isCreating ? (props.mode === "pick-folder" ? "Adding…" : "Cloning…") : actionLabel}
      </Button>
    </DialogFooter>
  );
}

export interface ProjectAddFormHandle {
  submit: () => Promise<boolean>;
  getTrimmedInput: () => string;
  getMode: () => ProjectCreateMode;
}

interface ProjectAddFormProps {
  onSuccess: (normalizedPath: string, projectConfig: ProjectConfig) => void;
  onClose?: () => void;
  isOpen: boolean;
  onIsCreatingChange?: (isCreating: boolean) => void;
  autoFocus?: boolean;
  hideFooter?: boolean;
  showCancelButton?: boolean;
}

export const ProjectAddForm = React.forwardRef<ProjectAddFormHandle, ProjectAddFormProps>(
  function ProjectAddForm(props, ref) {
    const { api } = useAPI();
    const [mode, setMode] = useState<ProjectCreateMode>("pick-folder");
    const [isCreating, setIsCreating] = useState(false);
    const [defaultProjectDir, setDefaultProjectDir] = useState("");
    const [isLoadingDefaultCloneDir, setIsLoadingDefaultCloneDir] = useState(false);
    const [hasLoadedDefaultCloneDir, setHasLoadedDefaultCloneDir] = useState(false);
    const cloneDirLoadNonceRef = useRef(0);
    const projectCreateFormRef = useRef<ProjectCreateFormHandle | null>(null);
    const projectCloneFormRef = useRef<ProjectCloneFormHandle | null>(null);

    const setCreating = useCallback(
      (next: boolean) => {
        setIsCreating(next);
        props.onIsCreatingChange?.(next);
      },
      [props]
    );

    const ensureDefaultCloneDir = useCallback(async () => {
      if (!api || isLoadingDefaultCloneDir || hasLoadedDefaultCloneDir) {
        return;
      }

      setIsLoadingDefaultCloneDir(true);
      const nonce = cloneDirLoadNonceRef.current;

      try {
        const projectDir = await api.projects.getDefaultProjectDir();
        if (nonce !== cloneDirLoadNonceRef.current) {
          return; // Parent was closed/reopened while loading — discard stale result
        }
        setDefaultProjectDir(projectDir);
      } catch (err) {
        console.error("Failed to fetch default project directory:", err);
      } finally {
        if (nonce === cloneDirLoadNonceRef.current) {
          // Mark as loaded even on failure to prevent infinite retry loops
          // when the backend is unavailable.
          setHasLoadedDefaultCloneDir(true);
          setIsLoadingDefaultCloneDir(false);
        }
      }
    }, [api, hasLoadedDefaultCloneDir, isLoadingDefaultCloneDir]);

    useEffect(() => {
      if (!props.isOpen) {
        cloneDirLoadNonceRef.current++;
        setMode("pick-folder");
        setCreating(false);
        setDefaultProjectDir("");
        setHasLoadedDefaultCloneDir(false);
        setIsLoadingDefaultCloneDir(false);
        return;
      }

      void ensureDefaultCloneDir();
    }, [ensureDefaultCloneDir, props.isOpen, setCreating]);

    useEffect(() => {
      if (!props.isOpen || mode !== "clone") {
        return;
      }

      void ensureDefaultCloneDir();
    }, [ensureDefaultCloneDir, mode, props.isOpen]);

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

    useImperativeHandle(
      ref,
      () => ({
        submit: async () => {
          if (mode === "pick-folder") {
            return (await projectCreateFormRef.current?.submit()) ?? false;
          }
          return (await projectCloneFormRef.current?.submit()) ?? false;
        },
        getTrimmedInput: () => {
          if (mode === "pick-folder") {
            return projectCreateFormRef.current?.getTrimmedPath() ?? "";
          }
          return projectCloneFormRef.current?.getTrimmedRepoUrl() ?? "";
        },
        getMode: () => mode,
      }),
      [mode]
    );

    return (
      <>
        {/* ToggleGroup + form content are grouped so space-y-3 keeps them
            visually cohesive, while DialogFooter renders outside the wrapper
            as a direct DialogContent grid child for proper edge alignment. */}
        <div className="space-y-3">
          <ToggleGroup
            type="single"
            value={mode}
            onValueChange={handleModeChange}
            disabled={isCreating}
            className="h-9 bg-transparent"
          >
            <ToggleGroupItem value="pick-folder" size="sm" className="h-7 gap-1.5 px-3 text-[13px]">
              <FolderOpen className="h-3.5 w-3.5" />
              Local folder
            </ToggleGroupItem>
            <ToggleGroupItem value="clone" size="sm" className="h-7 gap-1.5 px-3 text-[13px]">
              <Github className="h-3.5 w-3.5" />
              Clone repo
            </ToggleGroupItem>
          </ToggleGroup>

          {mode === "pick-folder" ? (
            <ProjectCreateForm
              ref={projectCreateFormRef}
              onSuccess={props.onSuccess}
              onClose={props.onClose}
              showCancelButton={props.showCancelButton ?? false}
              autoFocus={props.autoFocus}
              onIsCreatingChange={setCreating}
              hideFooter
            />
          ) : (
            <ProjectCloneForm
              ref={projectCloneFormRef}
              onSuccess={props.onSuccess}
              onClose={props.onClose ?? NOOP}
              isOpen={props.isOpen}
              defaultProjectDir={defaultProjectDir}
              onIsCreatingChange={setCreating}
              hideFooter
              autoFocus={props.autoFocus}
            />
          )}
        </div>

        {/* Footer renders outside the wrapper so it's a direct child of
            DialogContent's grid, aligned edge-to-edge with the header. */}
        {!props.hideFooter && (
          <ProjectAddFormFooter
            mode={mode}
            isCreating={isCreating}
            showCancelButton={props.showCancelButton ?? false}
            createFormRef={projectCreateFormRef}
            cloneFormRef={projectCloneFormRef}
            onClose={props.onClose}
          />
        )}
      </>
    );
  }
);

ProjectAddForm.displayName = "ProjectAddForm";

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
          <DialogDescription>Pick a folder or clone a project repository</DialogDescription>
        </DialogHeader>

        <ProjectAddForm
          isOpen={isOpen}
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
