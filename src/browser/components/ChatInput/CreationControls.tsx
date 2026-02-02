import React, { useCallback, useEffect } from "react";
import {
  RUNTIME_MODE,
  type CoderWorkspaceConfig,
  type RuntimeMode,
  type ParsedRuntime,
  CODER_RUNTIME_PLACEHOLDER,
} from "@/common/types/runtime";
import type { RuntimeAvailabilityMap, RuntimeAvailabilityState } from "./useCreationWorkspace";
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
import { Loader2, Wand2, X } from "lucide-react";
import { PlatformPaths } from "@/common/utils/paths";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { Skeleton } from "../ui/skeleton";
import { DocsLink } from "../DocsLink";
import {
  RUNTIME_CHOICE_UI,
  type RuntimeChoice,
  type RuntimeIconProps,
} from "@/browser/utils/runtimeUi";
import type { WorkspaceNameState } from "@/browser/hooks/useWorkspaceName";
import type { CoderInfo } from "@/common/orpc/schemas/coder";
import type { SectionConfig } from "@/common/types/project";
import { resolveSectionColor } from "@/common/constants/ui";
import {
  CoderAvailabilityMessage,
  CoderWorkspaceForm,
  resolveCoderAvailability,
  type CoderAvailabilityState,
  type CoderControlsProps,
} from "./CoderControls";

/** Shared runtime config text input - used for SSH host, Docker image, etc. */
function RuntimeConfigInput(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled?: boolean;
  hasError?: boolean;
  id?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={props.id} className="text-muted-foreground text-xs">
        {props.label}
      </label>
      <input
        id={props.id}
        aria-label={props.ariaLabel}
        type="text"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        disabled={props.disabled}
        className={cn(
          "bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-36 rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50",
          props.hasError && "border-red-500"
        )}
      />
    </div>
  );
}

/** Credential sharing checkbox - used by Docker and Devcontainer runtimes */
function CredentialSharingCheckbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  docsPath: string;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        disabled={props.disabled}
        className="accent-accent"
      />
      <span className="text-muted">Share credentials (SSH, Git)</span>
      <DocsLink path={props.docsPath} />
    </label>
  );
}

interface CreationControlsProps {
  branches: string[];
  /** Whether branches have finished loading (to distinguish loading vs non-git repo) */
  branchesLoaded: boolean;
  trunkBranch: string;
  onTrunkBranchChange: (branch: string) => void;
  /** Currently selected runtime (discriminated union: SSH has host, Docker has image) */
  selectedRuntime: ParsedRuntime;
  /** Fallback Coder config to restore prior selections. */
  coderConfigFallback: CoderWorkspaceConfig;
  /** Fallback SSH host to restore when leaving Coder. */
  sshHostFallback: string;
  defaultRuntimeMode: RuntimeChoice;
  /** Set the currently selected runtime (discriminated union) */
  onSelectedRuntimeChange: (runtime: ParsedRuntime) => void;
  onSetDefaultRuntime: (mode: RuntimeChoice) => void;
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

  /** Policy: allowed runtime modes (null/undefined = allow all) */
  allowedRuntimeModes?: RuntimeMode[] | null;
  /** Policy: allow plain host SSH */
  allowSshHost?: boolean;
  /** Policy: allow Coder-backed SSH */
  allowSshCoder?: boolean;
  /** Optional policy error message to display near runtime controls */
  runtimePolicyError?: string | null;
  /** Coder CLI availability info (null while checking) */
  coderInfo?: CoderInfo | null;
  /** Coder workspace controls props (optional - only rendered when provided) */
  coderProps?: Omit<CoderControlsProps, "disabled">;
}

/** Runtime type button group with icons and colors */
interface RuntimeButtonGroupProps {
  value: RuntimeChoice;
  onChange: (mode: RuntimeChoice) => void;
  defaultMode: RuntimeChoice;
  onSetDefault: (mode: RuntimeChoice) => void;
  disabled?: boolean;
  runtimeAvailabilityState?: RuntimeAvailabilityState;
  coderInfo?: CoderInfo | null;
  allowedRuntimeModes?: RuntimeMode[] | null;
  allowSshHost?: boolean;
  allowSshCoder?: boolean;
}

const RUNTIME_CHOICE_ORDER: RuntimeChoice[] = [
  RUNTIME_MODE.LOCAL,
  RUNTIME_MODE.WORKTREE,
  RUNTIME_MODE.SSH,
  "coder",
  RUNTIME_MODE.DOCKER,
  RUNTIME_MODE.DEVCONTAINER,
];

const RUNTIME_CHOICE_OPTIONS: Array<{
  value: RuntimeChoice;
  label: string;
  description: string;
  docsPath: string;
  Icon: React.ComponentType<RuntimeIconProps>;
  // Active state colors using CSS variables for theme support
  activeClass: string;
  idleClass: string;
}> = RUNTIME_CHOICE_ORDER.map((mode) => {
  const ui = RUNTIME_CHOICE_UI[mode];
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

interface RuntimeButtonState {
  isModeDisabled: boolean;
  isPolicyDisabled: boolean;
  disabledReason?: string;
  isDefault: boolean;
}

const resolveRuntimeButtonState = (
  value: RuntimeChoice,
  availabilityMap: RuntimeAvailabilityMap | null,
  defaultMode: RuntimeChoice,
  coderAvailability: CoderAvailabilityState,
  allowedModeSet: Set<RuntimeMode> | null,
  allowSshHost: boolean,
  allowSshCoder: boolean
): RuntimeButtonState => {
  const isPolicyAllowed = (): boolean => {
    if (!allowedModeSet) {
      return true;
    }

    if (value === "coder") {
      return allowSshCoder;
    }

    if (value === RUNTIME_MODE.SSH) {
      // Host SSH is separate from Coder; block it when policy forbids host SSH.
      return allowSshHost;
    }

    return allowedModeSet.has(value);
  };

  const isPolicyDisabled = !isPolicyAllowed();

  // Coder availability: keep the button disabled with a reason until the CLI is ready.
  if (value === "coder" && coderAvailability.state !== "available") {
    return {
      isModeDisabled: true,
      isPolicyDisabled,
      disabledReason: isPolicyDisabled ? "Disabled by policy" : coderAvailability.reason,
      isDefault: defaultMode === value,
    };
  }

  // Coder is SSH under the hood; all other RuntimeChoice values are RuntimeMode identity.
  const availabilityKey = value === "coder" ? RUNTIME_MODE.SSH : value;
  const availability = availabilityMap?.[availabilityKey];
  // Disable only if availability is explicitly known and unavailable.
  // When availability is undefined (loading or fetch failed), allow selection
  // as fallback - the config picker will validate before creation.
  const isModeDisabled = availability !== undefined && !availability.available;
  const disabledReason = isPolicyDisabled
    ? "Disabled by policy"
    : availability && !availability.available
      ? availability.reason
      : undefined;

  return {
    isModeDisabled,
    isPolicyDisabled,
    disabledReason,
    isDefault: defaultMode === value,
  };
};

/** Aesthetic section picker with color accent */
interface SectionPickerProps {
  sections: SectionConfig[];
  selectedSectionId: string | null;
  onSectionChange: (sectionId: string | null) => void;
  disabled?: boolean;
}

function SectionPicker(props: SectionPickerProps) {
  const { sections, selectedSectionId, onSectionChange, disabled } = props;

  // Radix Select treats `""` as an "unselected" value; normalize any accidental
  // empty-string IDs back to null so the UI stays consistent.
  const normalizedSelectedSectionId =
    selectedSectionId && selectedSectionId.trim().length > 0 ? selectedSectionId : null;

  const selectedSection = normalizedSelectedSectionId
    ? sections.find((s) => s.id === normalizedSelectedSectionId)
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
      data-selected-section={normalizedSelectedSectionId ?? ""}
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
        value={normalizedSelectedSectionId ?? ""}
        onValueChange={(value) => onSectionChange(value.trim() ? value : null)}
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
      {normalizedSelectedSectionId && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Clear section selection"
              disabled={disabled}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onSectionChange(null);
              }}
              className={cn(
                "text-muted hover:text-error -mr-1 inline-flex size-5 items-center justify-center rounded-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                "disabled:pointer-events-none disabled:opacity-50"
              )}
            >
              <X className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Clear section</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function RuntimeButtonGroup(props: RuntimeButtonGroupProps) {
  const state = props.runtimeAvailabilityState;
  const availabilityMap = state?.status === "loaded" ? state.data : null;
  const coderInfo = props.coderInfo ?? null;
  const coderAvailability = resolveCoderAvailability(coderInfo);

  const allowSshHost = props.allowSshHost ?? true;
  const allowSshCoder = props.allowSshCoder ?? true;
  const allowedModeSet = props.allowedRuntimeModes ? new Set(props.allowedRuntimeModes) : null;
  const isSshModeAllowed = !allowedModeSet || allowedModeSet.has(RUNTIME_MODE.SSH);

  const isDevcontainerMissing =
    availabilityMap?.devcontainer?.available === false &&
    availabilityMap.devcontainer.reason === "No devcontainer.json found";
  // Hide devcontainer while loading OR when confirmed missing.
  // Only show when availability is loaded and devcontainer is available.
  // This prevents layout flash for projects without devcontainer.json (the common case).
  const hideDevcontainer = state?.status === "loading" || isDevcontainerMissing;
  // Keep Devcontainer visible when policy requires it so the selector doesn't go empty.
  const isDevcontainerOnlyPolicy =
    allowedModeSet?.size === 1 && allowedModeSet.has(RUNTIME_MODE.DEVCONTAINER);
  const shouldForceShowDevcontainer =
    props.value === RUNTIME_MODE.DEVCONTAINER ||
    (isDevcontainerOnlyPolicy && isDevcontainerMissing);

  // Match devcontainer UX: only surface Coder once availability is confirmed (no flash),
  // but keep it visible when policy requires it or when already selected to avoid an empty selector.
  const shouldForceShowCoder =
    props.value === "coder" || (allowSshCoder && !allowSshHost && isSshModeAllowed);
  const shouldShowCoder = coderAvailability.shouldShowRuntimeButton || shouldForceShowCoder;

  const runtimeVisibilityOverrides: Partial<Record<RuntimeChoice, boolean>> = {
    [RUNTIME_MODE.DEVCONTAINER]: !hideDevcontainer || shouldForceShowDevcontainer,
    coder: shouldShowCoder,
  };

  // Policy filtering keeps forbidden runtimes out of the selector so users don't
  // get stuck with defaults that can never be created.
  const runtimeOptions = RUNTIME_CHOICE_OPTIONS.filter((option) => {
    if (runtimeVisibilityOverrides[option.value] === false) {
      return false;
    }

    const { isPolicyDisabled } = resolveRuntimeButtonState(
      option.value,
      availabilityMap,
      props.defaultMode,
      coderAvailability,
      allowedModeSet,
      allowSshHost,
      allowSshCoder
    );

    if (isPolicyDisabled && props.value !== option.value) {
      return false;
    }

    return true;
  });

  return (
    <div className="flex flex-wrap gap-1 " role="group" aria-label="Runtime type">
      {runtimeOptions.map((option) => {
        const isActive = props.value === option.value;
        const { isModeDisabled, isPolicyDisabled, disabledReason, isDefault } =
          resolveRuntimeButtonState(
            option.value,
            availabilityMap,
            props.defaultMode,
            coderAvailability,
            allowedModeSet,
            allowSshHost,
            allowSshCoder
          );
        const isDisabled = Boolean(props.disabled) || isModeDisabled || isPolicyDisabled;
        const showDisabledReason = isModeDisabled || isPolicyDisabled;

        const Icon = option.Icon;

        const handleSetDefault = () => {
          props.onSetDefault(option.value);
        };

        return (
          <Tooltip key={option.value}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => props.onChange(option.value)}
                disabled={isDisabled}
                aria-pressed={isActive}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-all duration-150",
                  "cursor-pointer",
                  isActive ? option.activeClass : option.idleClass,
                  isDisabled && "cursor-not-allowed opacity-50"
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
              {showDisabledReason ? (
                <p className="mt-1 text-yellow-500">{disabledReason ?? "Unavailable"}</p>
              ) : (
                <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={handleSetDefault}
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
  // Coder is surfaced as a separate runtime option while keeping SSH as the config mode.
  const isCoderSelected =
    selectedRuntime.mode === RUNTIME_MODE.SSH && selectedRuntime.coder != null;
  const runtimeChoice: RuntimeChoice = isCoderSelected ? "coder" : runtimeMode;

  // Local runtime doesn't need a trunk branch selector (uses project dir as-is)
  const availabilityMap =
    runtimeAvailabilityState.status === "loaded" ? runtimeAvailabilityState.data : null;
  const showTrunkBranchSelector = props.branches.length > 0 && runtimeMode !== RUNTIME_MODE.LOCAL;
  // Show loading skeleton while branches are loading to avoid layout flash
  const showBranchLoadingPlaceholder = !props.branchesLoaded && runtimeMode !== RUNTIME_MODE.LOCAL;

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
      <div className="flex items-center gap-y-2" data-component="WorkspaceNameGroup">
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

        {/* Name input with magic wand */}
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <input
                id="workspace-name"
                type="text"
                value={nameState.name}
                onChange={handleNameChange}
                onFocus={handleInputFocus}
                placeholder={nameState.isGenerating ? "Generating..." : "workspace-name"}
                disabled={props.disabled}
                className={cn(
                  `border-border-medium focus:border-accent h-7 rounded-md
                   border border-transparent bg-transparent text-lg font-semibold 
                   field-sizing-content focus:border focus:bg-bg-dark focus:outline-none 
                   disabled:opacity-50 max-w-[50vw] sm:max-w-[40vw] lg:max-w-[30vw]`,
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
          {nameState.isGenerating ? (
            <Loader2 className="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleWandClick}
                  disabled={props.disabled}
                  className="flex shrink-0 items-center disabled:opacity-50"
                  aria-label={nameState.autoGenerate ? "Disable auto-naming" : "Enable auto-naming"}
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
        <div className="flex flex-col gap-2">
          <RuntimeButtonGroup
            value={runtimeChoice}
            onChange={(mode) => {
              if (mode === "coder") {
                if (!props.coderProps) {
                  return;
                }
                // Switch to SSH mode with the last known Coder config so prior selections restore.
                onSelectedRuntimeChange({
                  mode: "ssh",
                  host: CODER_RUNTIME_PLACEHOLDER,
                  coder: props.coderConfigFallback,
                });
                return;
              }
              // Convert mode to ParsedRuntime with appropriate defaults
              switch (mode) {
                case RUNTIME_MODE.SSH: {
                  const sshHost =
                    selectedRuntime.mode === "ssh" &&
                    selectedRuntime.host !== CODER_RUNTIME_PLACEHOLDER
                      ? selectedRuntime.host
                      : props.sshHostFallback;
                  onSelectedRuntimeChange({
                    mode: "ssh",
                    host: sshHost,
                  });
                  break;
                }
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
            coderInfo={props.coderInfo ?? props.coderProps?.coderInfo ?? null}
            allowedRuntimeModes={props.allowedRuntimeModes}
            allowSshHost={props.allowSshHost}
            allowSshCoder={props.allowSshCoder}
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
          {/* Loading placeholder - reserves space while branches load to avoid layout flash */}
          {showBranchLoadingPlaceholder && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">from</span>
              <div className="bg-bg-dark/50 h-7 w-24 animate-pulse rounded-md" />
            </div>
          )}

          {/* SSH Host Input - hidden when Coder runtime is selected */}
          {selectedRuntime.mode === "ssh" &&
            !isCoderSelected &&
            (props.allowSshHost ?? true) &&
            !props.coderProps?.enabled &&
            // Also hide when Coder is still checking but has saved config (will enable after check)
            !(props.coderProps?.coderInfo === null && props.coderProps?.coderConfig) && (
              <RuntimeConfigInput
                label="host"
                value={selectedRuntime.host}
                onChange={(value) => onSelectedRuntimeChange({ mode: "ssh", host: value })}
                placeholder="user@host"
                disabled={props.disabled}
                hasError={props.runtimeFieldError === "ssh"}
              />
            )}

          {/* Runtime-specific config inputs */}

          {selectedRuntime.mode === "docker" && (
            <RuntimeConfigInput
              label="image"
              value={selectedRuntime.image}
              onChange={(value) =>
                onSelectedRuntimeChange({
                  mode: "docker",
                  image: value,
                  shareCredentials: selectedRuntime.shareCredentials,
                })
              }
              placeholder="node:20"
              disabled={props.disabled}
              hasError={props.runtimeFieldError === "docker"}
              id="docker-image"
              ariaLabel="Docker image"
            />
          )}
        </div>

        {props.runtimePolicyError && (
          // Explain why send is blocked when policy forbids the selected runtime.
          <p className="text-xs text-red-500">{props.runtimePolicyError}</p>
        )}

        {/* Dev container controls - config dropdown/input + credential sharing */}
        {selectedRuntime.mode === "devcontainer" && devcontainerSelection.uiMode !== "hidden" && (
          <div className="border-border-medium flex w-fit flex-col gap-1.5 rounded-md border p-2">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground text-xs">Config</label>
              {devcontainerSelection.uiMode === "loading" ? (
                // Skeleton placeholder while loading - matches dropdown dimensions
                <Skeleton className="h-6 w-[280px] rounded-md" />
              ) : devcontainerSelection.uiMode === "dropdown" ? (
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
            <CredentialSharingCheckbox
              checked={selectedRuntime.shareCredentials ?? false}
              onChange={(checked) =>
                onSelectedRuntimeChange({
                  mode: "devcontainer",
                  configPath: devcontainerSelection.configPath,
                  shareCredentials: checked,
                })
              }
              disabled={props.disabled}
              docsPath="/runtime/docker#credential-sharing"
            />
          </div>
        )}

        {/* Credential sharing - separate row for consistency with Coder controls */}
        {selectedRuntime.mode === "docker" && (
          <CredentialSharingCheckbox
            checked={selectedRuntime.shareCredentials ?? false}
            onChange={(checked) =>
              onSelectedRuntimeChange({
                mode: "docker",
                image: selectedRuntime.image,
                shareCredentials: checked,
              })
            }
            disabled={props.disabled}
            docsPath="/runtime/docker#credential-sharing"
          />
        )}

        {/* Coder Controls - shown when Coder runtime is selected */}
        {isCoderSelected && props.coderProps && (
          <div className="flex flex-col gap-1.5" data-testid="coder-controls">
            {/* Coder runtime needs availability status without the SSH-only toggle. */}
            <CoderAvailabilityMessage coderInfo={props.coderProps.coderInfo} />
            {props.coderProps.enabled && (
              <CoderWorkspaceForm
                coderConfig={props.coderProps.coderConfig}
                onCoderConfigChange={props.coderProps.onCoderConfigChange}
                templates={props.coderProps.templates}
                presets={props.coderProps.presets}
                existingWorkspaces={props.coderProps.existingWorkspaces}
                loadingTemplates={props.coderProps.loadingTemplates}
                loadingPresets={props.coderProps.loadingPresets}
                loadingWorkspaces={props.coderProps.loadingWorkspaces}
                disabled={props.disabled}
                hasError={props.runtimeFieldError === "ssh"}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
