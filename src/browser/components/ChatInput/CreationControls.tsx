import React, { useCallback, useEffect } from "react";
import { RUNTIME_MODE, type RuntimeMode, type ParsedRuntime } from "@/common/types/runtime";
import type { RuntimeAvailabilityMap } from "./useCreationWorkspace";
import { Select } from "../Select";
import { Loader2, Wand2 } from "lucide-react";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { SSHIcon, WorktreeIcon, LocalIcon, DockerIcon } from "../icons/RuntimeIcons";
import { DocsLink } from "../DocsLink";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import type { SectionConfig } from "@/common/types/project";
import { resolveSectionColor } from "@/common/constants/ui";

interface CreationControlsProps {
  branches: string[];
  /** Whether branches have finished loading (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  defaultRuntimeMode: RuntimeMode;
  /** Set the currently selected runtime (discriminated union) */
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
  onSetDefaultRuntime: (mode: RuntimeMode) => void;
  disabled: boolean;
  /** Project name to display as header */
  projectName: string;
  /** Workspace name/title generation state and actions */
  nameState: WorkspaceNameState;
  /** Runtime availability for each mode (null while loading) */
  runtimeAvailability: RuntimeAvailabilityMap | null;
  /** Available sections for this project */
  sections?: SectionConfig[];
  /** Currently selected section ID */
  selectedSectionId?: string | null;
  /** Callback when section selection changes */
  onSectionChange?: (sectionId: string | null) => void;
}

/** Runtime type button group with icons and colors */
interface RuntimeButtonGroupProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  defaultMode: RuntimeMode;
  onSetDefault: (mode: RuntimeMode) => void;
  disabled?: boolean;
  runtimeAvailability?: RuntimeAvailabilityMap | null;
}

const RUNTIME_OPTIONS: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  docsPath: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  // Active state colors using CSS variables for theme support
  activeClass: string;
  idleClass: string;
}> = [
  {
    value: RUNTIME_MODE.LOCAL,
    label: "Local",
    description: "Work directly in project directory",
    docsPath: "/runtime/local",
    Icon: LocalIcon,
    activeClass:
      "bg-[var(--color-runtime-local)]/30 text-foreground border-[var(--color-runtime-local)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-local)]/40",
  },
  {
    value: RUNTIME_MODE.WORKTREE,
    label: "Worktree",
    description: "Isolated git worktree",
    docsPath: "/runtime/worktree",
    Icon: WorktreeIcon,
    activeClass:
      "bg-[var(--color-runtime-worktree)]/20 text-[var(--color-runtime-worktree-text)] border-[var(--color-runtime-worktree)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-worktree)]/40",
  },
  {
    value: RUNTIME_MODE.SSH,
    label: "SSH",
    description: "Clone on SSH host",
    docsPath: "/runtime/ssh",
    Icon: SSHIcon,
    activeClass:
      "bg-[var(--color-runtime-ssh)]/20 text-[var(--color-runtime-ssh-text)] border-[var(--color-runtime-ssh)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-ssh)]/40",
  },
  {
    value: RUNTIME_MODE.DOCKER,
    label: "Docker",
    description: "Run in Docker container",
    docsPath: "/runtime/docker",
    Icon: DockerIcon,
    activeClass:
      "bg-[var(--color-runtime-docker)]/20 text-[var(--color-runtime-docker-text)] border-[var(--color-runtime-docker)]/60",
    idleClass:
      "bg-transparent text-muted border-transparent hover:border-[var(--color-runtime-docker)]/40",
  },
];

/** Aesthetic section picker with color accent */
interface SectionPickerProps {
  sections: SectionConfig[];
  selectedSectionId: string | null;
  onSectionChange: (sectionId: string | null) => void;
  disabled?: boolean;
}

function SectionPicker(props: SectionPickerProps) {
  const { sections, selectedSectionId, onSectionChange, disabled } = props;

  const selectedSection = selectedSectionId
    ? sections.find((s) => s.id === selectedSectionId)
    : null;
  const sectionColor = resolveSectionColor(selectedSection?.color);

  return (
    <div
      className="inline-flex w-fit items-center gap-2.5 rounded-md border px-3 py-1.5 transition-colors"
      style={{
        borderColor: selectedSection ? sectionColor : "var(--color-border-medium)",
        borderLeftWidth: selectedSection ? "3px" : "1px",
        backgroundColor: selectedSection ? `${sectionColor}08` : "transparent",
      }}
      data-testid="section-selector"
      data-selected-section={selectedSectionId ?? ""}
    >
      {/* Color indicator dot */}
      <div
        className="size-2.5 shrink-0 rounded-full transition-colors"
        style={{
          backgroundColor: selectedSection ? sectionColor : "var(--color-muted)",
          opacity: selectedSection ? 1 : 0.4,
        }}
      />
      <label htmlFor="workspace-section" className="text-muted-foreground shrink-0 text-xs">
        Section
      </label>
      <select
        id="workspace-section"
        value={selectedSectionId ?? ""}
        onChange={(e) => onSectionChange(e.target.value || null)}
        disabled={disabled}
        className={cn(
          "bg-transparent text-sm font-medium focus:outline-none cursor-pointer disabled:cursor-not-allowed disabled:opacity-50",
          selectedSection ? "text-foreground" : "text-muted"
        )}
      >
        <option value="">None</option>
        {sections.map((section) => (
          <option key={section.id} value={section.id}>
            {section.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function RuntimeButtonGroup(props: RuntimeButtonGroupProps) {
  return (
    <div className="flex gap-1" role="group" aria-label="Runtime type">
      {RUNTIME_OPTIONS.map((option) => {
        const isActive = props.value === option.value;
        const isDefault = props.defaultMode === option.value;
        const availability = props.runtimeAvailability?.[option.value];
        const isModeDisabled = availability !== undefined && !availability.available;
        const disabledReason =
          availability && !availability.available ? availability.reason : undefined;
        const Icon = option.Icon;

        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => props.onChange(option.value)}
                disabled={Boolean(props.disabled) || isModeDisabled}
                aria-pressed={isActive}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-150",
                  "cursor-pointer",
                  isActive ? option.activeClass : option.idleClass,
                  (Boolean(props.disabled) || isModeDisabled) && "cursor-not-allowed opacity-50"
                )}
              >
                <Icon size={12} />
                {option.label}
              </button>
            </TooltipTrigger>
            <TooltipContent
              align="center"
              side="bottom"
              className="pointer-events-auto whitespace-normal"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span>{option.description}</span>
                <DocsLink path={option.docsPath} />
              </div>
              {isModeDisabled ? (
                <p className="mt-1 text-yellow-500">{disabledReason ?? "Unavailable"}</p>
              ) : (
                <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={() => props.onSetDefault(option.value)}
                    className="accent-accent h-3 w-3"
                  />
                  <span className="text-muted">Default for project</span>
                </label>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/**
 * Prominent controls shown above the input during workspace creation.
 * Displays project name as header, workspace name with magic wand, and runtime/branch selectors.
 */
export function CreationControls(props: CreationControlsProps) {
  const { nameState, runtimeAvailability } = props;

  // Extract mode from discriminated union for convenience
  const runtimeMode = props.selectedRuntime.mode;

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const showTrunkBranchSelector = props.branches.length > 0 && runtimeMode !== RUNTIME_MODE.LOCAL;

  const { selectedRuntime, onSelectedRuntimeChange } = props;

  // Check if git is required (worktree unavailable due to git or no branches)
  const isNonGitRepo =
    (runtimeAvailability?.worktree?.available === false &&
      runtimeAvailability.worktree.reason === "Requires git repository") ||
    (props.branchesLoaded && props.branches.length === 0);

  // Force local runtime for non-git directories
  useEffect(() => {
    if (isNonGitRepo && selectedRuntime.mode !== RUNTIME_MODE.LOCAL) {
      onSelectedRuntimeChange({ mode: "local" });
    }
  }, [isNonGitRepo, selectedRuntime.mode, onSelectedRuntimeChange]);

  const handleNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      nameState.setName(e.target.value);
    },
    [nameState]
  );

  // Clicking into the input disables auto-generation so user can edit
  const handleInputFocus = useCallback(() => {
    if (nameState.autoGenerate) {
      nameState.setAutoGenerate(false);
    }
  }, [nameState]);

  // Toggle auto-generation via wand button
  const handleWandClick = useCallback(() => {
    nameState.setAutoGenerate(!nameState.autoGenerate);
  }, [nameState]);

  return (
    <div className="mb-3 flex flex-col gap-4">
      {/* Project name / workspace name header row - wraps on narrow viewports */}
      <div className="flex flex-wrap items-center gap-y-2" data-component="WorkspaceNameGroup">
        <h2 className="text-foreground shrink-0 text-lg font-semibold">{props.projectName}</h2>
        <span className="text-muted-foreground mx-2 text-lg">/</span>

        {/* Name input with magic wand - uses grid overlay technique for auto-sizing */}
        <div className="relative inline-grid items-center">
          {/* Hidden sizer span - determines width based on content, minimum is placeholder width */}
          <span className="invisible col-start-1 row-start-1 pr-7 text-lg font-semibold whitespace-pre">
            {nameState.name || "workspace-name"}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <input
                id="workspace-name"
                type="text"
                size={1}
                value={nameState.name}
                onChange={handleNameChange}
                onFocus={handleInputFocus}
                placeholder={nameState.isGenerating ? "Generating..." : "workspace-name"}
                disabled={props.disabled}
                className={cn(
                  "col-start-1 row-start-1 min-w-0 bg-transparent border-border-medium focus:border-accent h-7 w-full rounded-md border border-transparent text-lg font-semibold focus:border focus:bg-bg-dark focus:outline-none disabled:opacity-50",
                  nameState.autoGenerate ? "text-muted" : "text-foreground",
                  nameState.error && "border-red-500"
                )}
              />
            </TooltipTrigger>
            <TooltipContent align="start" className="max-w-64">
              A stable identifier used for git branches, worktree folders, and session directories.
            </TooltipContent>
          </Tooltip>
          {/* Magic wand / loading indicator */}
          <div className="absolute inset-y-0 right-0 flex items-center pr-2">
            {nameState.isGenerating ? (
              <Loader2 className="text-accent h-3.5 w-3.5 animate-spin" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleWandClick}
                    disabled={props.disabled}
                    className="flex h-full items-center disabled:opacity-50"
                    aria-label={
                      nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"
                    }
                  >
                    <Wand2
                      className={cn(
                        "h-3.5 w-3.5 transition-colors",
                        nameState.autoGenerate
                          ? "text-accent"
                          : "text-muted-foreground opacity-50 hover:opacity-75"
                      )}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent align="center">
                  {nameState.autoGenerate ? "Auto-naming enabled" : "Click to enable auto-naming"}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Error display */}
        {nameState.error && <span className="text-xs text-red-500">{nameState.error}</span>}

        {/* Section selector - right-aligned, same row as workspace name */}
        {props.sections && props.sections.length > 0 && props.onSectionChange && (
          <>
            <div className="flex-1" />
            <SectionPicker
              sections={props.sections}
              selectedSectionId={props.selectedSectionId ?? null}
              onSectionChange={props.onSectionChange}
              disabled={props.disabled}
            />
          </>
        )}
      </div>

      {/* Runtime type - button group */}
      <div className="flex flex-col gap-1.5" data-component="RuntimeTypeGroup">
        <label className="text-muted-foreground text-xs font-medium">Workspace Type</label>
        <div className="flex flex-wrap items-center gap-3">
          <RuntimeButtonGroup
            value={runtimeMode}
            onChange={(mode) => {
              // Convert mode to ParsedRuntime with appropriate defaults
              switch (mode) {
                case RUNTIME_MODE.SSH:
                  onSelectedRuntimeChange({
                    mode: "ssh",
                    host: selectedRuntime.mode === "ssh" ? selectedRuntime.host : "",
                  });
                  break;
                case RUNTIME_MODE.DOCKER:
                  onSelectedRuntimeChange({
                    mode: "docker",
                    image: selectedRuntime.mode === "docker" ? selectedRuntime.image : "",
                  });
                  break;
                case RUNTIME_MODE.LOCAL:
                  onSelectedRuntimeChange({ mode: "local" });
                  break;
                case RUNTIME_MODE.WORKTREE:
                default:
                  onSelectedRuntimeChange({ mode: "worktree" });
                  break;
              }
            }}
            defaultMode={props.defaultRuntimeMode}
            onSetDefault={props.onSetDefaultRuntime}
            disabled={props.disabled}
            runtimeAvailability={runtimeAvailability}
          />

          {/* Branch selector - shown for worktree/SSH */}
          {showTrunkBranchSelector && (
            <div
              className="flex items-center gap-2"
              data-component="TrunkBranchGroup"
              data-tutorial="trunk-branch"
            >
              <label htmlFor="trunk-branch" className="text-muted-foreground text-xs">
                from
              </label>
              <Select
                id="trunk-branch"
                value={props.trunkBranch}
                options={props.branches}
                onChange={props.onTrunkBranchChange}
                disabled={props.disabled}
                className="h-7 max-w-[140px]"
              />
            </div>
          )}

          {/* SSH Host Input */}
          {selectedRuntime.mode === "ssh" && (
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground text-xs">host</label>
              <input
                type="text"
                value={selectedRuntime.host}
                onChange={(e) => onSelectedRuntimeChange({ mode: "ssh", host: e.target.value })}
                placeholder="user@host"
                disabled={props.disabled}
                className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
              />
            </div>
          )}

          {/* Docker Image Input */}
          {selectedRuntime.mode === "docker" && (
            <div className="flex items-center gap-2">
              <label htmlFor="docker-image" className="text-muted-foreground text-xs">
                image
              </label>
              <input
                id="docker-image"
                aria-label="Docker image"
                type="text"
                value={selectedRuntime.image}
                onChange={(e) =>
                  onSelectedRuntimeChange({
                    mode: "docker",
                    image: e.target.value,
                    shareCredentials: selectedRuntime.shareCredentials,
                  })
                }
                placeholder="node:20"
                disabled={props.disabled}
                className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
              />
            </div>
          )}

          {/* Docker Credential Sharing */}
          {selectedRuntime.mode === "docker" && (
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={selectedRuntime.shareCredentials ?? false}
                onChange={(e) =>
                  onSelectedRuntimeChange({
                    mode: "docker",
                    image: selectedRuntime.image,
                    shareCredentials: e.target.checked,
                  })
                }
                disabled={props.disabled}
                className="accent-accent"
              />
              <span className="text-muted">Share credentials (SSH, Git)</span>
              <DocsLink path="/runtime/docker#credential-sharing" />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}
