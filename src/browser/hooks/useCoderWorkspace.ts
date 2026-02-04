/**
 * Hook for managing Coder workspace async data in the creation flow.
 * Fetches Coder CLI info, templates, presets, and existing workspaces.
 *
 * The `coderConfig` state is owned by the parent (via selectedRuntime.coder) and passed in.
 * This hook only manages async-fetched data and derived state.
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import type {
  CoderInfo,
  CoderTemplate,
  CoderPreset,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";
import type { CoderWorkspaceConfig } from "@/common/types/runtime";

/**
 * Returns an auto-selected template config if no template is set, otherwise null.
 * Preserves existing config fields (like preset) when auto-selecting.
 */
export function buildAutoSelectedTemplateConfig(
  currentConfig: CoderWorkspaceConfig | null,
  templates: CoderTemplate[]
): CoderWorkspaceConfig | null {
  if (templates.length === 0 || currentConfig?.template || currentConfig?.existingWorkspace) {
    return null;
  }
  const firstTemplate = templates[0];
  const firstIsDuplicate = templates.some(
    (t) => t.name === firstTemplate.name && t.organizationName !== firstTemplate.organizationName
  );
  return {
    ...(currentConfig ?? {}),
    existingWorkspace: false,
    template: firstTemplate.name,
    templateOrg: firstIsDuplicate ? firstTemplate.organizationName : undefined,
  };
}

interface UseCoderWorkspaceOptions {
  /** Current Coder config (null = disabled, owned by parent via selectedRuntime.coder) */
  coderConfig: CoderWorkspaceConfig | null;
  /** Callback to update Coder config (updates selectedRuntime.coder) */
  onCoderConfigChange: (config: CoderWorkspaceConfig | null) => void;
}

interface UseCoderWorkspaceReturn {
  /** Whether Coder is enabled (derived: coderConfig != null AND coderInfo available) */
  enabled: boolean;
  /** Toggle Coder on/off (calls onCoderConfigChange with config or null) */
  setEnabled: (enabled: boolean) => void;

  /** Coder CLI availability info */
  coderInfo: CoderInfo | null;

  /** Current Coder configuration (passed through from props) */
  coderConfig: CoderWorkspaceConfig | null;
  /** Update Coder config (passed through from props) */
  setCoderConfig: (config: CoderWorkspaceConfig | null) => void;

  /** Available templates */
  templates: CoderTemplate[];
  /** Error message when templates fail to load (null = no error) */
  templatesError: string | null;
  /** Presets for the currently selected template */
  presets: CoderPreset[];
  /** Error message when presets fail to load (null = no error) */
  presetsError: string | null;
  /** Running Coder workspaces */
  existingWorkspaces: CoderWorkspace[];
  /** Error message when workspaces fail to load (null = no error) */
  workspacesError: string | null;

  /** Loading states */
  loadingTemplates: boolean;
  loadingPresets: boolean;
  loadingWorkspaces: boolean;
}

/**
 * Manages Coder workspace async data for the creation flow.
 *
 * Fetches data lazily:
 * - Coder info is fetched on mount
 * - Templates are fetched when Coder is enabled
 * - Presets are fetched when a template is selected
 * - Workspaces are fetched when Coder is enabled
 *
 * State ownership: coderConfig is owned by parent (selectedRuntime.coder).
 * This hook derives `enabled` from coderConfig and manages only async data.
 */
export function useCoderWorkspace({
  coderConfig,
  onCoderConfigChange,
}: UseCoderWorkspaceOptions): UseCoderWorkspaceReturn {
  const { api } = useAPI();

  // Async-fetched data (owned by this hook)
  const [coderInfo, setCoderInfo] = useState<CoderInfo | null>(null);

  // Derived state: enabled when coderConfig is present AND CLI is confirmed available
  // Loading (null) and outdated/unavailable all result in enabled=false
  const enabled = coderConfig != null && coderInfo?.state === "available";

  // Refs to access current values in async callbacks (avoids stale closures)
  const coderConfigRef = useRef(coderConfig);
  const onCoderConfigChangeRef = useRef(onCoderConfigChange);
  coderConfigRef.current = coderConfig;
  onCoderConfigChangeRef.current = onCoderConfigChange;
  const [templates, setTemplates] = useState<CoderTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [presets, setPresets] = useState<CoderPreset[]>([]);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [existingWorkspaces, setExistingWorkspaces] = useState<CoderWorkspace[]>([]);
  const [workspacesError, setWorkspacesError] = useState<string | null>(null);

  // Loading states
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);

  // Fetch Coder info on mount
  useEffect(() => {
    if (!api) return;

    let mounted = true;

    api.coder
      .getInfo()
      .then((info) => {
        if (mounted) {
          setCoderInfo(info);
          // Clear Coder config when CLI is not available (outdated or unavailable)
          if (info.state !== "available" && coderConfigRef.current != null) {
            onCoderConfigChangeRef.current(null);
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setCoderInfo({
            state: "unavailable",
            reason: { kind: "error", message: "Failed to fetch" },
          });
          // Clear Coder config on fetch failure
          if (coderConfigRef.current != null) {
            onCoderConfigChangeRef.current(null);
          }
        }
      });

    return () => {
      mounted = false;
    };
  }, [api]);

  // Fetch templates when Coder is enabled
  useEffect(() => {
    if (!api || !enabled || coderInfo?.state !== "available") {
      setTemplates([]);
      setTemplatesError(null);
      setLoadingTemplates(false);
      return;
    }

    let mounted = true;
    setLoadingTemplates(true);
    setTemplatesError(null);

    api.coder
      .listTemplates()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          setTemplates(result.templates);
          setTemplatesError(null);
          // Auto-select first template if none selected
          const autoConfig = buildAutoSelectedTemplateConfig(
            coderConfigRef.current,
            result.templates
          );
          if (autoConfig) {
            onCoderConfigChange(autoConfig);
          }
        } else {
          setTemplates([]);
          setTemplatesError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted) return;
        const message =
          error instanceof Error
            ? error.message.split("\n")[0].slice(0, 200).trim()
            : "Unknown error";
        setTemplates([]);
        setTemplatesError(message || "Unknown error");
      })
      .finally(() => {
        if (mounted) {
          setLoadingTemplates(false);
        }
      });

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally only re-fetch on enable/state changes, not on coderConfig changes
  }, [api, enabled, coderInfo?.state]);

  // Fetch existing workspaces when Coder is enabled
  useEffect(() => {
    if (!api || !enabled || coderInfo?.state !== "available") {
      setExistingWorkspaces([]);
      setWorkspacesError(null);
      setLoadingWorkspaces(false);
      return;
    }

    let mounted = true;
    setLoadingWorkspaces(true);
    setWorkspacesError(null);

    api.coder
      .listWorkspaces()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          setExistingWorkspaces(result.workspaces);
          setWorkspacesError(null);
        } else {
          // Users reported "No workspaces found" even when the CLI failed; surface the error.
          setExistingWorkspaces([]);
          setWorkspacesError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted) return;
        const message =
          error instanceof Error
            ? error.message.split("\n")[0].slice(0, 200).trim()
            : "Unknown error";
        setExistingWorkspaces([]);
        setWorkspacesError(message || "Unknown error");
      })
      .finally(() => {
        if (mounted) {
          setLoadingWorkspaces(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [api, enabled, coderInfo?.state]);

  // Fetch presets when template changes (only for "new" mode)
  useEffect(() => {
    if (!api || !enabled || !coderConfig?.template || coderConfig.existingWorkspace) {
      setPresets([]);
      setPresetsError(null);
      setLoadingPresets(false);
      return;
    }

    let mounted = true;
    setLoadingPresets(true);
    setPresetsError(null);

    // Capture template/org at request time to detect stale responses
    const templateAtRequest = coderConfig.template;
    const orgAtRequest = coderConfig.templateOrg;

    api.coder
      .listPresets({ template: templateAtRequest, org: orgAtRequest })
      .then((result) => {
        if (!mounted) {
          return;
        }

        // Stale response guard: if user changed template/org while request was in-flight, ignore this response
        if (
          coderConfigRef.current?.template !== templateAtRequest ||
          coderConfigRef.current?.templateOrg !== orgAtRequest
        ) {
          return;
        }

        if (result.ok) {
          setPresets(result.presets);
          setPresetsError(null);

          // Presets rules (per spec):
          // - 0 presets: no dropdown
          // - 1 preset: auto-select silently
          // - 2+ presets: dropdown shown, auto-select default if exists, otherwise user must pick
          // Use ref to get current config (avoids stale closure if user changed config during fetch)
          const currentConfig = coderConfigRef.current;
          if (currentConfig && !currentConfig.existingWorkspace) {
            if (result.presets.length === 1) {
              const onlyPreset = result.presets[0];
              if (onlyPreset && currentConfig.preset !== onlyPreset.name) {
                onCoderConfigChange({ ...currentConfig, preset: onlyPreset.name });
              }
            } else if (result.presets.length >= 2 && !currentConfig.preset) {
              // Auto-select default preset if available, otherwise first preset
              // This keeps UI and config in sync (UI falls back to first preset for display)
              const defaultPreset = result.presets.find((p) => p.isDefault);
              const presetToSelect = defaultPreset ?? result.presets[0];
              if (presetToSelect) {
                onCoderConfigChange({ ...currentConfig, preset: presetToSelect.name });
              }
            } else if (result.presets.length === 0 && currentConfig.preset) {
              onCoderConfigChange({ ...currentConfig, preset: undefined });
            }
          }
        } else {
          setPresets([]);
          setPresetsError(result.error);
        }
      })
      .catch((error) => {
        if (!mounted) {
          return;
        }
        if (
          coderConfigRef.current?.template !== templateAtRequest ||
          coderConfigRef.current?.templateOrg !== orgAtRequest
        ) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message.split("\n")[0].slice(0, 200).trim()
            : "Unknown error";
        setPresets([]);
        setPresetsError(message || "Unknown error");
      })
      .finally(() => {
        // Only clear loading for the active request (not stale ones)
        if (
          mounted &&
          coderConfigRef.current?.template === templateAtRequest &&
          coderConfigRef.current?.templateOrg === orgAtRequest
        ) {
          setLoadingPresets(false);
        }
      });

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Only re-fetch on template/org/existingWorkspace changes, not on preset changes (would cause loop)
  }, [
    api,
    enabled,
    coderConfig?.template,
    coderConfig?.templateOrg,
    coderConfig?.existingWorkspace,
  ]);

  // Handle enabled toggle
  const handleSetEnabled = useCallback(
    (newEnabled: boolean) => {
      if (newEnabled) {
        // Initialize config for new workspace mode (workspaceName omitted; backend derives)
        const firstTemplate = templates[0];
        const firstIsDuplicate = firstTemplate
          ? templates.some(
              (t) =>
                t.name === firstTemplate.name &&
                t.organizationName !== firstTemplate.organizationName
            )
          : false;
        onCoderConfigChange({
          existingWorkspace: false,
          template: firstTemplate?.name,
          templateOrg: firstIsDuplicate ? firstTemplate?.organizationName : undefined,
        });
      } else {
        onCoderConfigChange(null);
      }
    },
    [templates, onCoderConfigChange]
  );

  return {
    enabled,
    setEnabled: handleSetEnabled,
    coderInfo,
    coderConfig,
    setCoderConfig: onCoderConfigChange,
    templates,
    templatesError,
    presets,
    presetsError,
    existingWorkspaces,
    workspacesError,
    loadingTemplates,
    loadingPresets,
    loadingWorkspaces,
  };
}
