/**
 * Coder workspace controls for the SSH-based Coder runtime.
 * Enables creating or connecting to Coder cloud workspaces.
 */
import React from "react";
import type {
  CoderInfo,
  CoderTemplate,
  CoderPreset,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";
import { cn } from "@/common/lib/utils";
import { Loader2 } from "lucide-react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

export interface CoderControlsProps {
  /** Whether Coder is enabled for this workspace */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;

  /** Coder CLI availability info (null while checking) */
  coderInfo: CoderInfo | null;

  /** Current Coder configuration */
  coderConfig: CoderWorkspaceConfig | null;
  onCoderConfigChange: (config: CoderWorkspaceConfig | null) => void;

  /** Data for dropdowns (loaded async) */
  templates: CoderTemplate[];
  presets: CoderPreset[];
  existingWorkspaces: CoderWorkspace[];

  /** Loading states */
  loadingTemplates: boolean;
  loadingPresets: boolean;
  loadingWorkspaces: boolean;

  /** Disabled state (e.g., during creation) */
  disabled: boolean;

  /** Error state for visual feedback */
  hasError?: boolean;
}

type CoderMode = "new" | "existing";

const CODER_CHECKING_LABEL = "Checking…";

/** Check if a template name exists in multiple organizations (for disambiguation in UI) */
function hasTemplateDuplicateName(template: CoderTemplate, allTemplates: CoderTemplate[]): boolean {
  return allTemplates.some(
    (t) => t.name === template.name && t.organizationName !== template.organizationName
  );
}

export type CoderAvailabilityState =
  | { state: "loading"; shouldShowRuntimeButton: false }
  | { state: "outdated"; reason: string; shouldShowRuntimeButton: true }
  | { state: "unavailable"; shouldShowRuntimeButton: false }
  | { state: "available"; shouldShowRuntimeButton: true };

function getCoderOutdatedReason(coderInfo: Extract<CoderInfo, { state: "outdated" }>) {
  return `Coder CLI v${coderInfo.version} is below the minimum required v${coderInfo.minVersion}. Update the CLI to enable.`;
}

export function resolveCoderAvailability(coderInfo: CoderInfo | null): CoderAvailabilityState {
  if (coderInfo === null) {
    return { state: "loading", shouldShowRuntimeButton: false };
  }

  if (coderInfo.state === "outdated") {
    return {
      state: "outdated",
      reason: getCoderOutdatedReason(coderInfo),
      shouldShowRuntimeButton: true,
    };
  }

  if (coderInfo.state === "unavailable") {
    return { state: "unavailable", shouldShowRuntimeButton: false };
  }

  // Only show the runtime button once the CLI is confirmed available (matches devcontainer UX).
  return { state: "available", shouldShowRuntimeButton: true };
}

// Split status messaging from the SSH-only checkbox so the Coder runtime can render
// availability without a hidden toggle prop.
export function CoderAvailabilityMessage(props: { coderInfo: CoderInfo | null }) {
  const availability = resolveCoderAvailability(props.coderInfo);

  if (availability.state === "loading") {
    return (
      <span className="text-muted flex items-center gap-1 text-xs">
        <Loader2 className="h-3 w-3 animate-spin" />
        {CODER_CHECKING_LABEL}
      </span>
    );
  }

  if (availability.state === "outdated") {
    return <p className="text-xs text-yellow-500">{availability.reason}</p>;
  }

  return null;
}

function CoderEnableToggle(props: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
  coderInfo: CoderInfo | null;
}) {
  const availability = resolveCoderAvailability(props.coderInfo);

  if (availability.state === "loading") {
    return (
      <CoderCheckbox
        enabled={props.enabled}
        onEnabledChange={props.onEnabledChange}
        disabled={props.disabled}
        status={
          <span className="text-muted flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            {CODER_CHECKING_LABEL}
          </span>
        }
      />
    );
  }

  if (availability.state === "outdated") {
    return (
      <CoderCheckbox
        enabled={false}
        onEnabledChange={props.onEnabledChange}
        disabled={props.disabled}
        disabledReason={availability.reason}
      />
    );
  }

  if (availability.state === "unavailable") {
    return null;
  }

  return (
    <CoderCheckbox
      enabled={props.enabled}
      onEnabledChange={props.onEnabledChange}
      disabled={props.disabled}
    />
  );
}

export type CoderWorkspaceFormProps = Omit<
  CoderControlsProps,
  "enabled" | "onEnabledChange" | "coderInfo"
>;

/** Checkbox row with optional status indicator and tooltip for disabled state */
function CoderCheckbox(props: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
  status?: React.ReactNode;
  /** When provided, wraps checkbox in tooltip explaining why it's disabled */
  disabledReason?: string;
}) {
  const checkboxElement = (
    <label
      className={cn(
        "flex items-center gap-1.5 text-xs",
        props.disabledReason && "cursor-not-allowed"
      )}
    >
      <input
        type="checkbox"
        checked={props.enabled}
        onChange={(e) => props.onEnabledChange(e.target.checked)}
        disabled={props.disabled || Boolean(props.disabledReason)}
        className={cn("accent-accent", props.disabledReason && "cursor-not-allowed opacity-50")}
        data-testid="coder-checkbox"
      />
      <span className={cn("text-muted", props.disabledReason && "opacity-50")}>
        Use Coder Workspace
      </span>
      {props.status}
    </label>
  );

  // Wrap in tooltip when disabled with a reason
  if (props.disabledReason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-block">{checkboxElement}</span>
        </TooltipTrigger>
        <TooltipContent align="start" className="max-w-60">
          <p className="text-xs text-yellow-500">{props.disabledReason}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return checkboxElement;
}

export function CoderWorkspaceForm(props: CoderWorkspaceFormProps) {
  const {
    coderConfig,
    onCoderConfigChange,
    templates,
    presets,
    existingWorkspaces,
    loadingTemplates,
    loadingPresets,
    loadingWorkspaces,
    disabled,
    hasError,
  } = props;

  const mode: CoderMode = coderConfig?.existingWorkspace ? "existing" : "new";

  const handleModeChange = (newMode: CoderMode) => {
    if (newMode === "existing") {
      // Switch to existing workspace mode (workspaceName starts empty, user selects)
      onCoderConfigChange({
        workspaceName: undefined,
        existingWorkspace: true,
      });
    } else {
      // Switch to new workspace mode (workspaceName omitted; backend derives from branch)
      const firstTemplate = templates[0];
      const firstIsDuplicate = firstTemplate && hasTemplateDuplicateName(firstTemplate, templates);
      onCoderConfigChange({
        existingWorkspace: false,
        template: firstTemplate?.name,
        templateOrg: firstIsDuplicate ? firstTemplate?.organizationName : undefined,
      });
    }
  };

  const handleTemplateChange = (value: string) => {
    if (!coderConfig) return;

    // Value is "org/name" when duplicates exist, otherwise just "name"
    const [orgOrName, maybeName] = value.split("/");
    const templateName = maybeName ?? orgOrName;
    const templateOrg = maybeName ? orgOrName : undefined;

    onCoderConfigChange({
      ...coderConfig,
      template: templateName,
      templateOrg,
      preset: undefined, // Reset preset when template changes
    });
    // Presets will be loaded by parent via effect
  };

  const handlePresetChange = (presetName: string) => {
    if (!coderConfig) return;

    onCoderConfigChange({
      ...coderConfig,
      preset: presetName || undefined,
    });
  };

  const handleExistingWorkspaceChange = (workspaceName: string) => {
    onCoderConfigChange({
      workspaceName,
      existingWorkspace: true,
    });
  };

  // Preset value: hook handles auto-selection, but keep a UI fallback to avoid a brief
  // "Select preset" flash while async preset loading + config update races.
  const defaultPresetName = presets.find((p) => p.isDefault)?.name;
  const effectivePreset =
    presets.length === 0
      ? undefined
      : presets.length === 1
        ? presets[0]?.name
        : (coderConfig?.preset ?? defaultPresetName ?? presets[0]?.name);

  return (
    <div
      className={cn(
        "flex w-fit rounded-md border",
        hasError ? "border-red-500" : "border-border-medium"
      )}
      data-testid="coder-controls-inner"
    >
      {/* Left column: New/Existing toggle buttons */}
      <div
        className="border-border-medium flex flex-col gap-1 border-r p-2 pr-3"
        role="group"
        aria-label="Coder workspace mode"
        data-testid="coder-mode-toggle"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => handleModeChange("new")}
              disabled={disabled}
              className={cn(
                "rounded-md border px-2 py-1 text-xs transition-colors",
                mode === "new"
                  ? "border-accent bg-accent/20 text-foreground"
                  : "border-transparent bg-transparent text-muted hover:border-border-medium"
              )}
              aria-pressed={mode === "new"}
            >
              New
            </button>
          </TooltipTrigger>
          <TooltipContent>Create a new Coder workspace from a template</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => handleModeChange("existing")}
              disabled={disabled}
              className={cn(
                "rounded-md border px-2 py-1 text-xs transition-colors",
                mode === "existing"
                  ? "border-accent bg-accent/20 text-foreground"
                  : "border-transparent bg-transparent text-muted hover:border-border-medium"
              )}
              aria-pressed={mode === "existing"}
            >
              Existing
            </button>
          </TooltipTrigger>
          <TooltipContent>Connect to an existing Coder workspace</TooltipContent>
        </Tooltip>
      </div>

      {/* Right column: Mode-specific controls */}
      {/* New workspace controls - template/preset stacked vertically */}
      {mode === "new" && (
        <div className="flex flex-col gap-1 p-2 pl-3">
          <div className="flex h-7 items-center gap-2">
            <label className="text-muted-foreground w-16 text-xs">Template</label>
            {loadingTemplates ? (
              <Loader2 className="text-muted h-4 w-4 animate-spin" />
            ) : (
              <Select
                value={(() => {
                  const templateName = coderConfig?.template;
                  if (!templateName) {
                    return "";
                  }

                  const matchingTemplates = templates.filter((t) => t.name === templateName);
                  const firstMatch = matchingTemplates[0];
                  const hasDuplicate =
                    firstMatch && hasTemplateDuplicateName(firstMatch, templates);

                  if (!hasDuplicate) {
                    return templateName;
                  }

                  const org = coderConfig?.templateOrg ?? firstMatch?.organizationName ?? undefined;
                  return org ? `${org}/${templateName}` : templateName;
                })()}
                onValueChange={handleTemplateChange}
                disabled={disabled || templates.length === 0}
              >
                <SelectTrigger
                  className="h-7 w-[180px] text-xs"
                  data-testid="coder-template-select"
                >
                  <SelectValue placeholder="No templates" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => {
                    // Show org name only if there are duplicate template names
                    const hasDuplicate = hasTemplateDuplicateName(t, templates);
                    // Use org/name as value when duplicates exist for disambiguation
                    const itemValue = hasDuplicate ? `${t.organizationName}/${t.name}` : t.name;
                    return (
                      <SelectItem key={`${t.organizationName}/${t.name}`} value={itemValue}>
                        {t.displayName || t.name}
                        {hasDuplicate && (
                          <span className="text-muted ml-1">({t.organizationName})</span>
                        )}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex h-7 items-center gap-2">
            <label className="text-muted-foreground w-16 text-xs">Preset</label>
            {loadingPresets ? (
              <Loader2 className="text-muted h-4 w-4 animate-spin" />
            ) : (
              <Select
                value={effectivePreset ?? ""}
                onValueChange={handlePresetChange}
                disabled={disabled || presets.length === 0}
              >
                <SelectTrigger className="h-7 w-[180px] text-xs" data-testid="coder-preset-select">
                  <SelectValue placeholder="No presets" />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((p) => (
                    <SelectItem key={p.id} value={p.name}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      )}

      {/* Existing workspace controls - min-h matches New mode (2×h-7 + gap-1 + p-2) */}
      {mode === "existing" && (
        <div className="flex min-h-[4.75rem] min-w-[16rem] items-center gap-2 p-2 pl-3">
          <label className="text-muted-foreground text-xs">Workspace</label>
          {loadingWorkspaces ? (
            <Loader2 className="text-muted h-4 w-4 animate-spin" />
          ) : (
            <Select
              value={coderConfig?.workspaceName ?? ""}
              onValueChange={handleExistingWorkspaceChange}
              disabled={disabled || existingWorkspaces.length === 0}
            >
              <SelectTrigger className="h-7 w-[180px] text-xs" data-testid="coder-workspace-select">
                <SelectValue
                  placeholder={
                    existingWorkspaces.length === 0 ? "No workspaces found" : "Select workspace..."
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {existingWorkspaces
                  .filter((w) => w.status !== "deleted" && w.status !== "deleting")
                  .map((w) => (
                    <SelectItem key={w.name} value={w.name}>
                      {w.name}
                      <span className="text-muted ml-1">
                        ({w.templateDisplayName} • {w.status})
                      </span>
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );
}

export function CoderControls(props: CoderControlsProps) {
  const availability = resolveCoderAvailability(props.coderInfo);

  if (availability.state === "unavailable") {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="coder-controls">
      <CoderEnableToggle
        enabled={props.enabled}
        onEnabledChange={props.onEnabledChange}
        disabled={props.disabled}
        coderInfo={props.coderInfo}
      />
      {availability.state === "available" && props.enabled && (
        <CoderWorkspaceForm
          coderConfig={props.coderConfig}
          onCoderConfigChange={props.onCoderConfigChange}
          templates={props.templates}
          presets={props.presets}
          existingWorkspaces={props.existingWorkspaces}
          loadingTemplates={props.loadingTemplates}
          loadingPresets={props.loadingPresets}
          loadingWorkspaces={props.loadingWorkspaces}
          disabled={props.disabled}
          hasError={props.hasError}
        />
      )}
    </div>
  );
}
