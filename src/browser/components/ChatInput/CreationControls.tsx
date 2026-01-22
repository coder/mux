import React, { useCallback, useEffect } from "react";
import { RUNTIME_MODE, type RuntimeMode, type ParsedRuntime } from "@/common/types/runtime";
import { type RuntimeAvailabilityState } from "./useCreationWorkspace";
import {
  resolveDevcontainerSelection,
  DEFAULT_DEVCONTAINER_CONFIG_PATH,
} from "@/browser/utils/devcontainerSelection";
import { Select } from "../Select";
import {
  Select as RadixSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Loader2, Wand2 } from "lucide-react";
import { PlatformPaths } from "@/common/utils/paths";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { DocsLink } from "../DocsLink";
import { RUNTIME_UI, type RuntimeIconProps } from "@/browser/utils/runtimeUi";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import type { SectionConfig } from "@/common/types/project";
import { resolveSectionColor } from "@/common/constants/ui";
import { CoderControls, type CoderControlsProps } from "./CoderControls";

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
  /** Project path to display (and used for project selector) */
  projectPath: string;
  /** Project name to display as header */
  projectName: string;
  /** Workspace name/title generation state and actions */
  nameState: WorkspaceNameState;
  /** Runtime availability state for each mode */
  runtimeAvailabilityState: RuntimeAvailabilityState;
  /** Available sections for this project */
  sections?: SectionConfig[];
  /** Currently selected section ID */
  selectedSectionId?: string | null;
  /** Callback when section selection changes */
  onSectionChange?: (sectionId: string | null) => void;
  /** Which runtime field (if any) is in error state for visual feedback */
  runtimeFieldError?: "docker" | "ssh" | null;
  /** Coder workspace controls props (optional - only rendered when provided) */
  coderProps?: Omit<CoderControlsProps, "disabled">;
}

/** Runtime type button group with icons and colors */
interface RuntimeButtonGroupProps {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  defaultMode: RuntimeMode;
  onSetDefault: (mode: RuntimeMode) => void;
  disabled?: boolean;
  runtimeAvailabilityState?: RuntimeAvailabilityState;
}

const RUNTIME_ORDER: RuntimeMode[] = [
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.SSH,
  RUNTIME_MODE.DOCKER,
  RUNTIME_MODE.DEVCONTAINER,
];

const RUNTIME_OPTIONS: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  docsPath: string;
  Icon: React.ComponentType<RuntimeIconProps>;
  // Active state colors using CSS variables for theme support
  activeClass: string;
  idleClass: string;
}> = RUNTIME_ORDER.map((mode) => {
  const ui = RUNTIME_UI[mode];
  return {
    value: mode,
    label: ui.label,
    description: ui.description,
    docsPath: ui.docsPath,
    Icon: ui.Icon,
    activeClass: ui.button.activeClass,
    idleClass: ui.button.idleClass,
  };
});

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
      <label className="text-muted-foreground shrink-0 text-xs">Section</label>
      <RadixSelect
        value={selectedSectionId ?? ""}
        onValueChange={onSectionChange}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn(
            "h-auto border-0 bg-transparent px-0 py-0 text-sm font-medium shadow-none focus:ring-0",
            selectedSection ? "text-foreground" : "text-muted"
          )}
        >
          <SelectValue placeholder="Select..." />
        </SelectTrigger>
        <SelectContent>
          {sections.map((section) => (
            <SelectItem key={section.id} value={section.id}>
              {section.name}
            </SelectItem>
          ))}
        </SelectContent>
      </RadixSelect>
    </div>
  );
}

function RuntimeButtonGroup(props: RuntimeButtonGroupProps) {
  const availabilityMap =
    props.runtimeAvailabilityState?.status === "loaded"
      ? props.runtimeAvailabilityState.data
      : null;
  const hideDevcontainer =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";

  const runtimeOptions = hideDevcontainer
    ? RUNTIME_OPTIONS.filter((option) => option.value !== RUNTIME_MODE.DEVCONTAINER)
    : RUNTIME_OPTIONS;

  return (
    <div className="flex gap-1" role="group" aria-label="Runtime type">
      {runtimeOptions.map((option) => {
        const isActive = props.value === option.value;
        const isDefault = props.defaultMode === option.value;
        const availability = availabilityMap?.[option.value];
        // Disable only if availability is explicitly known and unavailable.
        // When availability is undefined (loading or fetch failed), allow selection
        // as fallback - the config picker will validate before creation.
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
  const { projects } = useProjectContext();
  const { beginWorkspaceCreation } = useWorkspaceContext();
  const { nameState, runtimeAvailabilityState } = props;

  // Extract mode from discriminated union for convenience
  const runtimeMode = props.selectedRuntime.mode;
  const { selectedRuntime, onSelectedRuntimeChange } = props;

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;
  const showTrunkBranchSelector = props.branches.length > 0 && runtimeMode !== RUNTIME_MODE.LOCAL;

  // Centralized devcontainer selection logic
  const devcontainerSelection = resolveDevcontainerSelection({
    selectedRuntime,
    availabilityState: runtimeAvailabilityState,
  });

  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";

  // Check if git is required (worktree unavailable due to git or no branches)
  const isNonGitRepo =
    (availabilityMap?.worktree?.available === false &&
      availabilityMap.worktree.reason === "Requires git repository") ||
    (props.branchesLoaded && props.branches.length === 0);

  // Keep selected runtime aligned with availability constraints
  useEffect(() => {
    if (isNonGitRepo) {
      if (selectedRuntime.mode !== RUNTIME_MODE.LOCAL) {
        onSelectedRuntimeChange({ mode: "local" });
      }
      return;
    }

    if (isDevcontainerMissing && selectedRuntime.mode === RUNTIME_MODE.DEVCONTAINER) {
      onSelectedRuntimeChange({ mode: "worktree" });
    }
  }, [isDevcontainerMissing, isNonGitRepo, selectedRuntime.mode, onSelectedRuntimeChange]);

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
        {projects.size > 1 ? (
          <RadixSelect
            value={props.projectPath}
            onValueChange={(path) => beginWorkspaceCreation(path)}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <SelectTrigger
                  aria-label="Select project"
                  data-testid="project-selector"
                  className="text-foreground hover:bg-toggle-bg/70 h-7 w-auto max-w-[280px] shrink-0 border-transparent bg-transparent px-0 text-lg font-semibold shadow-none"
                >
                  <SelectValue placeholder={props.projectName} />
                </SelectTrigger>
              </TooltipTrigger>
              <TooltipContent align="start">{props.projectPath}</TooltipContent>
            </Tooltip>
            <SelectContent>
              {Array.from(projects.keys()).map((path) => (
                <SelectItem key={path} value={path}>
                  {PlatformPaths.basename(path)}
                </SelectItem>
              ))}
            </SelectContent>
          </RadixSelect>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <h2 className="text-foreground shrink-0 text-lg font-semibold">
                {props.projectName}
              </h2>
            </TooltipTrigger>
            <TooltipContent align="start">{props.projectPath}</TooltipContent>
          </Tooltip>
        )}
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
                case RUNTIME_MODE.DEVCONTAINER: {
                  // Use resolver to get initial config path (prefers first available config)
                  const initialSelection = resolveDevcontainerSelection({
                    selectedRuntime: { mode: "devcontainer", configPath: "" },
                    availabilityState: runtimeAvailabilityState,
                  });
                  onSelectedRuntimeChange({
                    mode: "devcontainer",
                    configPath:
                      selectedRuntime.mode === "devcontainer"
                        ? selectedRuntime.configPath
                        : initialSelection.configPath,
                    shareCredentials:
                      selectedRuntime.mode === "devcontainer"
                        ? selectedRuntime.shareCredentials
                        : false,
                  });
                  break;
                }
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
            runtimeAvailabilityState={runtimeAvailabilityState}
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

          {/* SSH Host Input - hidden when Coder is enabled */}
          {selectedRuntime.mode === "ssh" && !props.coderProps?.enabled && (
            <div className="flex items-center gap-2">
              <label className="text-muted-foreground text-xs">host</label>
              <input
                type="text"
                value={selectedRuntime.host}
                onChange={(e) => onSelectedRuntimeChange({ mode: "ssh", host: e.target.value })}
                placeholder="user@host"
                disabled={props.disabled}
                className={cn(
                  "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50",
                  props.runtimeFieldError === "ssh" && "border-red-500"
                )}
              />
            </div>
          )}

          {/* Runtime-specific config inputs */}

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
                className={cn(
                  "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50",
                  props.runtimeFieldError === "docker" && "border-red-500"
                )}
              />
            </div>
          )}
        </div>

        {/* Dev container controls - config dropdown/input + credential sharing */}
        {selectedRuntime.mode === "devcontainer" && devcontainerSelection.uiMode !== "hidden" && (
          <div className="border-border-medium flex w-fit flex-col gap-1.5 rounded-md border p-2">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Config</label>
              {devcontainerSelection.uiMode === "dropdown" ? (
                <RadixSelect
                  value={devcontainerSelection.configPath}
                  onValueChange={(value) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  disabled={props.disabled}
                >
                  <SelectTrigger
                    className="h-6 w-[280px] text-xs"
                    aria-label="Dev container config"
                  >
                    <SelectValue placeholder="Select config" />
                  </SelectTrigger>
                  <SelectContent>
                    {devcontainerSelection.configs.map((config) => (
                      <SelectItem key={config.path} value={config.path}>
                        {config.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </RadixSelect>
              ) : (
                <input
                  type="text"
                  value={devcontainerSelection.configPath}
                  onChange={(e) =>
                    onSelectedRuntimeChange({
                      mode: "devcontainer",
                      configPath: e.target.value,
                      shareCredentials: selectedRuntime.shareCredentials,
                    })
                  }
                  placeholder={DEFAULT_DEVCONTAINER_CONFIG_PATH}
                  disabled={props.disabled}
                  className={cn(
                    "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[280px] rounded-md border px-2 text-xs focus:outline-none disabled:opacity-50"
                  )}
                  aria-label="Dev container config path"
                />
              )}
            </div>
            {devcontainerSelection.helperText && (
              <p className="text-muted-foreground text-xs">{devcontainerSelection.helperText}</p>
            )}
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={selectedRuntime.shareCredentials ?? false}
                onChange={(e) =>
                  onSelectedRuntimeChange({
                    mode: "devcontainer",
                    configPath: devcontainerSelection.configPath,
                    shareCredentials: e.target.checked,
                  })
                }
                disabled={props.disabled}
                className="accent-accent"
              />
              <span className="text-muted">Share credentials (SSH, Git)</span>
              <DocsLink path="/runtime/docker#credential-sharing" />
            </label>
          </div>
        )}

        {/* Credential sharing - separate row for consistency with Coder controls */}
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

        {/* Coder Controls - shown when SSH mode is selected and Coder is available */}
        {selectedRuntime.mode === "ssh" && props.coderProps && (
          <CoderControls
            {...props.coderProps}
            disabled={props.disabled}
            hasError={props.runtimeFieldError === "ssh"}
          />
        )}
      </div>
    </div>
  );
}
