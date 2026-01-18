import React, {
  useCallback,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAPI } from "@/browser/contexts/API";
import assert from "@/common/utils/assert";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  normalizeLayoutPresetsConfig,
  type LayoutPreset,
  type LayoutPresetsConfig,
  type LayoutSlotNumber,
} from "@/common/types/uiLayouts";
import {
  applyLayoutPresetToWorkspace,
  createPresetFromCurrentWorkspace,
  getLayoutsConfigOrDefault,
  getPresetById,
  getPresetForSlot,
  updateSlotAssignment,
  updateSlotKeybindOverride,
  upsertPreset,
} from "@/browser/utils/uiLayouts";
import type { Keybind } from "@/common/types/keybind";

interface UILayoutsContextValue {
  layoutPresets: LayoutPresetsConfig;
  loaded: boolean;
  loadFailed: boolean;
  refresh: () => Promise<void>;
  saveAll: (next: LayoutPresetsConfig) => Promise<void>;

  applySlotToWorkspace: (workspaceId: string, slot: LayoutSlotNumber) => Promise<void>;
  applyPresetToWorkspace: (workspaceId: string, presetId: string) => Promise<void>;
  saveCurrentWorkspaceAsPreset: (
    workspaceId: string,
    name: string,
    slot?: LayoutSlotNumber | null
  ) => Promise<LayoutPreset>;

  setSlotPreset: (slot: LayoutSlotNumber, presetId: string | undefined) => Promise<void>;
  setSlotKeybindOverride: (slot: LayoutSlotNumber, keybind: Keybind | undefined) => Promise<void>;
  deletePreset: (presetId: string) => Promise<void>;
  renamePreset: (presetId: string, newName: string) => Promise<void>;
  updatePresetFromCurrentWorkspace: (workspaceId: string, presetId: string) => Promise<void>;
}

const UILayoutsContext = createContext<UILayoutsContextValue | null>(null);

export function useUILayouts(): UILayoutsContextValue {
  const ctx = useContext(UILayoutsContext);
  if (!ctx) {
    throw new Error("useUILayouts must be used within UILayoutsProvider");
  }
  return ctx;
}

export function UILayoutsProvider(props: { children: ReactNode }) {
  const { api } = useAPI();

  const [layoutPresets, setLayoutPresets] = useState<LayoutPresetsConfig>(
    DEFAULT_LAYOUT_PRESETS_CONFIG
  );
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!api) {
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(false);
      return;
    }

    try {
      const remote = await api.uiLayouts.getAll();
      setLayoutPresets(getLayoutsConfigOrDefault(remote));
      setLoaded(true);
      setLoadFailed(false);
    } catch {
      setLayoutPresets(DEFAULT_LAYOUT_PRESETS_CONFIG);
      setLoaded(true);
      setLoadFailed(true);
    }
  }, [api]);

  const getConfigForWrite = useCallback(async (): Promise<LayoutPresetsConfig> => {
    if (!api) {
      return layoutPresets;
    }

    if (loaded && !loadFailed) {
      return layoutPresets;
    }

    // Avoid overwriting an existing config with defaults before the initial load completes.
    const remote = await api.uiLayouts.getAll();
    const normalized = getLayoutsConfigOrDefault(remote);

    setLayoutPresets(normalized);
    setLoaded(true);
    setLoadFailed(false);

    return normalized;
  }, [api, layoutPresets, loaded, loadFailed]);

  const saveAll = useCallback(
    async (next: LayoutPresetsConfig): Promise<void> => {
      const normalized = normalizeLayoutPresetsConfig(next);

      if (!api) {
        throw new Error("ORPC client not initialized");
      }

      await api.uiLayouts.saveAll({ layoutPresets: normalized });
      setLayoutPresets(normalized);
    },
    [api]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyPresetToWorkspace = useCallback(
    async (workspaceId: string, presetId: string): Promise<void> => {
      const preset = getPresetById(layoutPresets, presetId);
      if (!preset) {
        return;
      }

      await applyLayoutPresetToWorkspace(api ?? null, workspaceId, preset);
    },
    [api, layoutPresets]
  );

  const applySlotToWorkspace = useCallback(
    async (workspaceId: string, slot: LayoutSlotNumber): Promise<void> => {
      const preset = getPresetForSlot(layoutPresets, slot);
      if (!preset) {
        return;
      }

      await applyLayoutPresetToWorkspace(api ?? null, workspaceId, preset);
    },
    [api, layoutPresets]
  );

  const saveCurrentWorkspaceAsPreset = useCallback(
    async (
      workspaceId: string,
      name: string,
      slot?: LayoutSlotNumber | null
    ): Promise<LayoutPreset> => {
      assert(
        typeof workspaceId === "string" && workspaceId.length > 0,
        "workspaceId must be non-empty"
      );

      const base = await getConfigForWrite();

      const preset = createPresetFromCurrentWorkspace(workspaceId, name);
      let next = upsertPreset(base, preset);
      if (slot != null) {
        next = updateSlotAssignment(next, slot, preset.id);
      }
      await saveAll(next);
      return preset;
    },
    [getConfigForWrite, saveAll]
  );

  const updatePresetFromCurrentWorkspace = useCallback(
    async (workspaceId: string, presetId: string): Promise<void> => {
      const base = await getConfigForWrite();

      const existing = getPresetById(base, presetId);
      if (!existing) {
        return;
      }

      const next = createPresetFromCurrentWorkspace(workspaceId, existing.name, presetId);
      await saveAll(upsertPreset(base, next));
    },
    [getConfigForWrite, saveAll]
  );

  const renamePreset = useCallback(
    async (presetId: string, newName: string): Promise<void> => {
      const trimmed = newName.trim();
      if (!trimmed) {
        return;
      }

      const base = await getConfigForWrite();
      const existing = getPresetById(base, presetId);
      if (!existing) {
        return;
      }

      await saveAll(
        upsertPreset(base, {
          ...existing,
          name: trimmed,
        })
      );
    },
    [getConfigForWrite, saveAll]
  );

  const deletePreset = useCallback(
    async (presetId: string): Promise<void> => {
      const base = await getConfigForWrite();

      const nextPresets = base.presets.filter((p) => p.id !== presetId);
      const nextSlots = base.slots.map((s) =>
        s.presetId === presetId ? { ...s, presetId: undefined } : s
      );

      await saveAll(
        normalizeLayoutPresetsConfig({
          version: 1,
          presets: nextPresets,
          slots: nextSlots,
        })
      );
    },
    [getConfigForWrite, saveAll]
  );

  const setSlotPreset = useCallback(
    async (slot: LayoutSlotNumber, presetId: string | undefined): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(updateSlotAssignment(base, slot, presetId));
    },
    [getConfigForWrite, saveAll]
  );

  const setSlotKeybindOverride = useCallback(
    async (slot: LayoutSlotNumber, keybind: Keybind | undefined): Promise<void> => {
      const base = await getConfigForWrite();
      await saveAll(updateSlotKeybindOverride(base, slot, keybind));
    },
    [getConfigForWrite, saveAll]
  );

  const value: UILayoutsContextValue = useMemo(
    () => ({
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      applyPresetToWorkspace,
      saveCurrentWorkspaceAsPreset,
      setSlotPreset,
      setSlotKeybindOverride,
      deletePreset,
      renamePreset,
      updatePresetFromCurrentWorkspace,
    }),
    [
      layoutPresets,
      loaded,
      loadFailed,
      refresh,
      saveAll,
      applySlotToWorkspace,
      applyPresetToWorkspace,
      saveCurrentWorkspaceAsPreset,
      setSlotPreset,
      setSlotKeybindOverride,
      deletePreset,
      renamePreset,
      updatePresetFromCurrentWorkspace,
    ]
  );

  return <UILayoutsContext.Provider value={value}>{props.children}</UILayoutsContext.Provider>;
}
