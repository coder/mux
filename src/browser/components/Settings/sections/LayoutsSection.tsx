import React, { useEffect, useMemo, useState } from "react";
import { Button } from "@/browser/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/ui/dialog";
import { Input } from "@/browser/components/ui/input";
import { Label } from "@/browser/components/ui/label";
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
    saveCurrentWorkspaceToSlot,
    renameSlot,
    clearSlot,
    setSlotKeybindOverride,
  } = useUILayouts();
  const { selectedWorkspace } = useWorkspaceContext();

  const [actionError, setActionError] = useState<string | null>(null);
  const [capturingSlot, setCapturingSlot] = useState<LayoutSlotNumber | null>(null);

  const [nameDialog, setNameDialog] = useState<{
    mode: "capture" | "rename";
    slot: LayoutSlotNumber;
  } | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
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
  const selectedWorkspaceLabel = selectedWorkspace
    ? `${selectedWorkspace.projectName}/${selectedWorkspace.namedWorkspacePath.split("/").pop() ?? selectedWorkspace.namedWorkspacePath}`
    : null;

  const openNameDialog = (mode: "capture" | "rename", slot: LayoutSlotNumber) => {
    setActionError(null);
    setNameError(null);

    const existingPreset = getPresetForSlot(layoutPresets, slot);
    const initialName = existingPreset?.name ?? `Slot ${slot}`;

    setNameDialog({ mode, slot });
    setNameValue(initialName);
  };

  const handleNameSubmit = async (): Promise<void> => {
    if (!nameDialog) {
      return;
    }

    const trimmed = nameValue.trim();
    if (!trimmed) {
      setNameError("Name is required.");
      return;
    }

    setNameError(null);
    setActionError(null);

    try {
      if (nameDialog.mode === "capture") {
        if (!workspaceId) {
          setActionError("Select a workspace to capture its layout.");
          return;
        }

        await saveCurrentWorkspaceToSlot(workspaceId, nameDialog.slot, trimmed);
      } else {
        await renameSlot(nameDialog.slot, trimmed);
      }

      setNameDialog(null);
    } catch {
      setNameError("Failed to save.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-foreground text-sm font-medium">Layout Slots</h3>
          <div className="text-muted mt-1 text-xs">
            Each slot stores a layout snapshot. Apply with Ctrl/Cmd+Alt+1..9 (customizable).
          </div>
          {selectedWorkspaceLabel ? (
            <div className="text-muted mt-1 text-xs">
              Selected workspace: {selectedWorkspaceLabel}
            </div>
          ) : (
            <div className="text-muted mt-1 text-xs">
              Select a workspace to capture/apply layouts.
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void refresh()}>
            Refresh
          </Button>
        </div>
      </div>

      {!loaded ? <div className="text-muted text-sm">Loading…</div> : null}
      {loadFailed ? (
        <div className="text-muted text-sm">
          Failed to load layouts from config. Using defaults.
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
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!workspaceId}
                    onClick={() => openNameDialog("capture", slot)}
                  >
                    Capture current…
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!assignedPreset}
                    onClick={() => openNameDialog("rename", slot)}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!assignedPreset}
                    onClick={() => {
                      if (!assignedPreset) return;
                      const ok = confirm(`Clear Slot ${slot} ("${assignedPreset.name}")?`);
                      if (!ok) return;
                      void clearSlot(slot).catch(() => {
                        setActionError("Failed to clear slot.");
                      });
                    }}
                  >
                    Clear
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
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
                          Reset Hotkey
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

      <Dialog
        open={nameDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNameDialog(null);
            setNameError(null);
          }
        }}
      >
        <DialogContent maxWidth="520px">
          <DialogHeader>
            <DialogTitle>
              {nameDialog?.mode === "capture" ? "Capture Layout" : "Rename Layout"}
            </DialogTitle>
            <DialogDescription>
              {nameDialog?.mode === "capture" ? (
                <>Capture the current layout into Slot {nameDialog?.slot}.</>
              ) : (
                <>Rename Slot {nameDialog?.slot}.</>
              )}
            </DialogDescription>
          </DialogHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleNameSubmit();
            }}
            className="space-y-4"
          >
            {nameDialog?.mode === "capture" ? (
              <div className="text-muted text-xs">
                Source workspace: {selectedWorkspaceLabel ?? "(none selected)"}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="layout-slot-name">Name</Label>
              <Input
                id="layout-slot-name"
                value={nameValue}
                onChange={(e) => setNameValue(e.target.value)}
                placeholder="Enter layout name"
                autoFocus
              />
              {nameError ? <div className="text-sm text-red-500">{nameError}</div> : null}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setNameDialog(null);
                  setNameError(null);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="default">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
