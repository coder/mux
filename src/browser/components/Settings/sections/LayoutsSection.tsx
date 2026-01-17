import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/browser/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { useWorkspaceContext } from "@/browser/contexts/WorkspaceContext";
import { useUILayouts } from "@/browser/contexts/UILayoutsContext";
import { getEffectiveSlotKeybind, getPresetForSlot } from "@/browser/utils/uiLayouts";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import { formatKeybind, isMac, KEYBINDS, matchesKeybind } from "@/browser/utils/ui/keybinds";
import type { Keybind } from "@/common/types/keybind";
import type { LayoutSlotNumber } from "@/common/types/uiLayouts";

function isModifierOnlyKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta";
}

function normalizeCapturedKeybind(e: KeyboardEvent): Keybind | null {
  if (!e.key || isModifierOnlyKey(e.key)) {
    return null;
  }

  // On macOS, we represent Cmd as ctrl=true so bindings remain cross-platform.
  const onMac = isMac();
  const ctrl = e.ctrlKey ? true : onMac ? e.metaKey : false;
  const meta = !onMac ? e.metaKey : false;

  return {
    key: e.key,
    ctrl: ctrl ? true : undefined,
    alt: e.altKey ? true : undefined,
    shift: e.shiftKey ? true : undefined,
    meta: meta ? true : undefined,
  };
}

function keybindConflicts(a: Keybind, b: Keybind): boolean {
  if (a.key.toLowerCase() !== b.key.toLowerCase()) {
    return false;
  }

  for (const ctrlKey of [false, true]) {
    for (const altKey of [false, true]) {
      for (const shiftKey of [false, true]) {
        for (const metaKey of [false, true]) {
          const ev = new KeyboardEvent("keydown", {
            key: a.key,
            ctrlKey,
            altKey,
            shiftKey,
            metaKey,
          });

          if (matchesKeybind(ev, a) && matchesKeybind(ev, b)) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function validateSlotKeybindOverride(params: {
  slot: LayoutSlotNumber;
  keybind: Keybind;
  existing: Array<{ slot: LayoutSlotNumber; keybind: Keybind }>;
}): string | null {
  const hasModifier = [
    params.keybind.ctrl,
    params.keybind.alt,
    params.keybind.shift,
    params.keybind.meta,
  ].some((v) => v === true);
  if (!hasModifier) {
    return "Keybind must include at least one modifier key.";
  }

  for (const core of Object.values(KEYBINDS)) {
    if (keybindConflicts(params.keybind, core)) {
      return `Conflicts with an existing mux shortcut (${formatKeybind(core)}).`;
    }
  }

  for (const entry of params.existing) {
    if (entry.slot === params.slot) {
      continue;
    }
    if (keybindConflicts(params.keybind, entry.keybind)) {
      return `Conflicts with Slot ${entry.slot} (${formatKeybind(entry.keybind)}).`;
    }
  }

  return null;
}

export function LayoutsSection() {
  const {
    layoutPresets,
    loaded,
    loadFailed,
    refresh,
    applySlotToWorkspace,
    applyPresetToWorkspace,
    saveCurrentWorkspaceAsPreset,
    setSlotPreset,
    setSlotKeybindOverride,
    deletePreset,
    renamePreset,
    updatePresetFromCurrentWorkspace,
  } = useUILayouts();
  const { selectedWorkspace } = useWorkspaceContext();

  const [actionError, setActionError] = useState<string | null>(null);
  const [capturingSlot, setCapturingSlot] = useState<LayoutSlotNumber | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const effectiveSlotKeybinds = useMemo(() => {
    return ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((slot) => ({
      slot,
      keybind: getEffectiveSlotKeybind(layoutPresets, slot),
    }));
  }, [layoutPresets]);

  useEffect(() => {
    if (!capturingSlot) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        stopKeyboardPropagation(e);
        setCapturingSlot(null);
        setCaptureError(null);
        return;
      }

      const captured = normalizeCapturedKeybind(e);
      if (!captured) {
        return;
      }

      e.preventDefault();
      stopKeyboardPropagation(e);

      const error = validateSlotKeybindOverride({
        slot: capturingSlot,
        keybind: captured,
        existing: effectiveSlotKeybinds,
      });

      if (error) {
        setCaptureError(error);
        return;
      }

      void setSlotKeybindOverride(capturingSlot, captured).catch(() => {
        setCaptureError("Failed to save keybind override.");
      });
      setCapturingSlot(null);
      setCaptureError(null);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [capturingSlot, effectiveSlotKeybinds, setSlotKeybindOverride]);

  const workspaceId = selectedWorkspace?.workspaceId ?? null;

  const handleSavePreset = async (): Promise<void> => {
    setActionError(null);

    if (!workspaceId) {
      setActionError("Select a workspace to save its layout.");
      return;
    }

    const name = window.prompt("Preset name:", "");
    const trimmed = name?.trim();
    if (!trimmed) {
      return;
    }

    try {
      await saveCurrentWorkspaceAsPreset(workspaceId, trimmed);
    } catch {
      setActionError("Failed to save preset.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-foreground text-sm font-medium">Layout Presets</h3>
          <div className="text-muted mt-1 text-xs">
            Save and re-apply sidebar layouts per workspace.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
          <Button variant="default" size="sm" onClick={() => void handleSavePreset()}>
            Save Current…
          </Button>
        </div>
      </div>

      {!loaded ? <div className="text-muted text-sm">Loading…</div> : null}
      {loadFailed ? (
        <div className="text-muted text-sm">
          Failed to load presets from config. Using defaults.
        </div>
      ) : null}
      {actionError ? <div className="text-sm text-red-500">{actionError}</div> : null}

      <div>
        <h4 className="text-foreground mb-3 text-sm font-medium">Slots (1–9)</h4>
        <div className="space-y-2">
          {([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((slot) => {
            const slotConfig = layoutPresets.slots.find((s) => s.slot === slot);
            const assignedPreset = getPresetForSlot(layoutPresets, slot);
            const effectiveKeybind = getEffectiveSlotKeybind(layoutPresets, slot);

            return (
              <div
                key={slot}
                className="border-border-medium bg-background-secondary flex flex-col gap-2 rounded border p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-foreground text-sm font-medium">Slot {slot}</div>
                    <div className="text-muted text-xs">
                      {assignedPreset ? assignedPreset.name : "Empty"}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <kbd className="bg-background-secondary text-foreground border-border-medium rounded border px-2 py-0.5 font-mono text-xs">
                      {formatKeybind(effectiveKeybind)}
                    </kbd>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!workspaceId || !assignedPreset}
                      onClick={() => {
                        if (!workspaceId) return;
                        void applySlotToWorkspace(workspaceId, slot).catch(() => {
                          setActionError("Failed to apply slot.");
                        });
                      }}
                    >
                      Apply
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={slotConfig?.presetId ?? "none"}
                    onValueChange={(value) => {
                      const presetId = value === "none" ? undefined : value;
                      void setSlotPreset(slot, presetId).catch(() => {
                        setActionError("Failed to update slot.");
                      });
                    }}
                  >
                    <SelectTrigger className="w-[280px]">
                      <SelectValue placeholder="Select preset" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Empty</SelectItem>
                      {layoutPresets.presets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {capturingSlot === slot ? (
                    <div className="text-muted text-xs">
                      Press a key combo (Esc to cancel)
                      {captureError ? (
                        <div className="mt-1 text-red-500">{captureError}</div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setCapturingSlot(slot);
                          setCaptureError(null);
                        }}
                      >
                        Set Hotkey…
                      </Button>
                      {slotConfig?.keybindOverride ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void setSlotKeybindOverride(slot, undefined).catch(() => {
                              setActionError("Failed to clear keybind override.");
                            });
                          }}
                        >
                          Clear Hotkey
                        </Button>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h4 className="text-foreground mb-3 text-sm font-medium">Presets</h4>
        <div className="space-y-2">
          {layoutPresets.presets.length === 0 ? (
            <div className="text-muted text-sm">No presets yet.</div>
          ) : null}

          {layoutPresets.presets.map((preset) => (
            <div
              key={preset.id}
              className="border-border-medium bg-background-secondary flex flex-col gap-2 rounded border p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-foreground text-sm font-medium">{preset.name}</div>
                  <div className="text-muted text-xs">ID: {preset.id}</div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!workspaceId}
                    onClick={() => {
                      if (!workspaceId) return;
                      void applyPresetToWorkspace(workspaceId, preset.id).catch(() => {
                        setActionError("Failed to apply preset.");
                      });
                    }}
                  >
                    Apply
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!workspaceId}
                    onClick={() => {
                      if (!workspaceId) return;
                      void updatePresetFromCurrentWorkspace(workspaceId, preset.id).catch(() => {
                        setActionError("Failed to update preset.");
                      });
                    }}
                  >
                    Update
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const next = window.prompt("Rename preset:", preset.name);
                      const trimmed = next?.trim();
                      if (!trimmed) return;
                      void renamePreset(preset.id, trimmed).catch(() => {
                        setActionError("Failed to rename preset.");
                      });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      const ok = confirm(`Delete preset "${preset.name}"?`);
                      if (!ok) return;
                      void deletePreset(preset.id).catch(() => {
                        setActionError("Failed to delete preset.");
                      });
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
