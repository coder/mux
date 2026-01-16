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
  /** Presets for the currently selected template */
  presets: CoderPreset[];
  /** Running Coder workspaces */
  existingWorkspaces: CoderWorkspace[];

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
  useEffect(() => {
    coderConfigRef.current = coderConfig;
    onCoderConfigChangeRef.current = onCoderConfigChange;
  }, [coderConfig, onCoderConfigChange]);
  const [templates, setTemplates] = useState<CoderTemplate[]>([]);
  const [presets, setPresets] = useState<CoderPreset[]>([]);
  const [existingWorkspaces, setExistingWorkspaces] = useState<CoderWorkspace[]>([]);

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
      setLoadingTemplates(false);
      return;
    }

    let mounted = true;
    setLoadingTemplates(true);

    api.coder
      .listTemplates()
      .then((result) => {
        if (mounted) {
          setTemplates(result);
          // Auto-select first template if none selected
          // Use ref to get current config (avoids stale closure if user toggled modes during fetch)
          const currentConfig = coderConfigRef.current;
          if (result.length > 0 && !currentConfig?.template && !currentConfig?.existingWorkspace) {
            const firstTemplate = result[0];
            const firstIsDuplicate = result.some(
              (t) =>
                t.name === firstTemplate.name &&
                t.organizationName !== firstTemplate.organizationName
            );
            onCoderConfigChange({
              existingWorkspace: false,
              template: firstTemplate.name,
              templateOrg: firstIsDuplicate ? firstTemplate.organizationName : undefined,
            });
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setTemplates([]);
        }
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
      setLoadingWorkspaces(false);
      return;
    }

    let mounted = true;
    setLoadingWorkspaces(true);

    api.coder
      .listWorkspaces()
      .then((result) => {
        if (mounted) {
          // Backend already filters to running workspaces by default
          setExistingWorkspaces(result);
        }
      })
      .catch(() => {
        if (mounted) {
          setExistingWorkspaces([]);
        }
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
      setLoadingPresets(false);
      return;
    }

    let mounted = true;
    setLoadingPresets(true);

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

        setPresets(result);

        // Presets rules (per spec):
        // - 0 presets: no dropdown
        // - 1 preset: auto-select silently
        // - 2+ presets: dropdown shown, auto-select default if exists, otherwise user must pick
        // Use ref to get current config (avoids stale closure if user changed config during fetch)
        const currentConfig = coderConfigRef.current;
        if (currentConfig && !currentConfig.existingWorkspace) {
          if (result.length === 1) {
            const onlyPreset = result[0];
            if (onlyPreset && currentConfig.preset !== onlyPreset.name) {
              onCoderConfigChange({ ...currentConfig, preset: onlyPreset.name });
            }
          } else if (result.length >= 2 && !currentConfig.preset) {
            // Auto-select default preset if available, otherwise first preset
            // This keeps UI and config in sync (UI falls back to first preset for display)
            const defaultPreset = result.find((p) => p.isDefault);
            const presetToSelect = defaultPreset ?? result[0];
            if (presetToSelect) {
              onCoderConfigChange({ ...currentConfig, preset: presetToSelect.name });
            }
          } else if (result.length === 0 && currentConfig.preset) {
            onCoderConfigChange({ ...currentConfig, preset: undefined });
          }
        }
      })
      .catch(() => {
        if (mounted) {
          setPresets([]);
        }
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
    presets,
    existingWorkspaces,
    loadingTemplates,
    loadingPresets,
    loadingWorkspaces,
  };
}
