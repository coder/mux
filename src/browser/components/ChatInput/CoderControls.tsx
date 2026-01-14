/**
 * Coder workspace controls for SSH runtime.
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

export interface CoderControlsProps {
  /** Whether to use Coder workspace (checkbox state) */
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

/**
 * Coder workspace controls component.
 * Shows checkbox to enable Coder, then New/Existing toggle with appropriate dropdowns.
 */
/** Checkbox row with optional status indicator */
function CoderCheckbox(props: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled: boolean;
  status?: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs">
      <input
        type="checkbox"
        checked={props.enabled}
        onChange={(e) => props.onEnabledChange(e.target.checked)}
        disabled={props.disabled}
        className="accent-accent"
        data-testid="coder-checkbox"
      />
      <span className="text-muted">Use Coder Workspace</span>
      {props.status}
    </label>
  );
}

export function CoderControls(props: CoderControlsProps) {
  const {
    enabled,
    onEnabledChange,
    coderInfo,
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

  // Coder CLI status: loading (null), unavailable (available=false), or available (available=true)
  if (coderInfo === null) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="coder-controls">
        <CoderCheckbox
          enabled={enabled}
          onEnabledChange={onEnabledChange}
          disabled={disabled}
          status={
            <span className="text-muted flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Checking…
            </span>
          }
        />
      </div>
    );
  }

  if (!coderInfo.available) {
    if (!enabled) return null;
    return (
      <div className="flex flex-col gap-1.5" data-testid="coder-controls">
        <CoderCheckbox
          enabled={enabled}
          onEnabledChange={onEnabledChange}
          disabled={disabled}
          status={<span className="text-yellow-500">(CLI unavailable)</span>}
        />
      </div>
    );
  }

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
      onCoderConfigChange({
        template: templates[0]?.name,
      });
    }
  };

  const handleTemplateChange = (templateName: string) => {
    if (!coderConfig) return;

    onCoderConfigChange({
      ...coderConfig,
      template: templateName,
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
        : (coderConfig?.preset ?? defaultPresetName);

  return (
    <div className="flex flex-col gap-1.5" data-testid="coder-controls">
      <CoderCheckbox enabled={enabled} onEnabledChange={onEnabledChange} disabled={disabled} />

      {/* Coder controls - only shown when enabled */}
      {enabled && (
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
                  <select
                    value={coderConfig?.template ?? ""}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    disabled={disabled || templates.length === 0}
                    className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[180px] rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
                    data-testid="coder-template-select"
                  >
                    {templates.length === 0 && <option value="">No templates</option>}
                    {templates.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.displayName || t.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex h-7 items-center gap-2">
                <label className="text-muted-foreground w-16 text-xs">Preset</label>
                {loadingPresets ? (
                  <Loader2 className="text-muted h-4 w-4 animate-spin" />
                ) : (
                  <select
                    value={effectivePreset ?? ""}
                    onChange={(e) => handlePresetChange(e.target.value)}
                    disabled={disabled || presets.length === 0}
                    className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[180px] rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
                    data-testid="coder-preset-select"
                  >
                    {presets.length === 0 && <option value="">No presets</option>}
                    {presets.length > 0 && <option value="">Select preset...</option>}
                    {presets.map((p) => (
                      <option key={p.id} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          )}

          {/* Existing workspace controls - min-h matches New mode (2×h-7 + gap-1 + p-2) */}
          {mode === "existing" && (
            <div className="flex min-h-[4.75rem] items-center gap-2 p-2 pl-3">
              <label className="text-muted-foreground text-xs">Workspace</label>
              {loadingWorkspaces ? (
                <Loader2 className="text-muted h-4 w-4 animate-spin" />
              ) : (
                <select
                  value={coderConfig?.workspaceName ?? ""}
                  onChange={(e) => handleExistingWorkspaceChange(e.target.value)}
                  disabled={disabled || existingWorkspaces.length === 0}
                  className="bg-bg-dark text-foreground border-border-medium focus:border-accent h-7 w-[180px] rounded-md border px-2 text-sm focus:outline-none disabled:opacity-50"
                  data-testid="coder-workspace-select"
                >
                  {existingWorkspaces.length === 0 && <option value="">No workspaces found</option>}
                  {existingWorkspaces.length > 0 && <option value="">Select workspace...</option>}
                  {existingWorkspaces.map((w) => (
                    <option key={w.name} value={w.name}>
                      {w.name} ({w.templateName}) • {w.status}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
