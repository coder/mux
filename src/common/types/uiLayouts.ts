import assert from "@/common/utils/assert";
import type { Keybind } from "@/common/types/keybind";
import { normalizeKeybind } from "@/common/types/keybind";

export type LayoutSlotNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface LayoutSlot {
  slot: LayoutSlotNumber;
  presetId?: string;
  keybindOverride?: Keybind;
}

export type RightSidebarPresetBaseTabType = "costs" | "review" | "explorer" | "stats";
export type RightSidebarPresetTabType = RightSidebarPresetBaseTabType | `terminal_new:${string}`;

export type RightSidebarLayoutPresetNode =
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      sizes: [number, number];
      children: [RightSidebarLayoutPresetNode, RightSidebarLayoutPresetNode];
    }
  | {
      type: "tabset";
      id: string;
      tabs: RightSidebarPresetTabType[];
      activeTab: RightSidebarPresetTabType;
    };

export interface RightSidebarLayoutPresetState {
  version: 1;
  nextId: number;
  focusedTabsetId: string;
  root: RightSidebarLayoutPresetNode;
}

export type RightSidebarWidthPreset =
  | {
      mode: "px";
      value: number;
    }
  | {
      mode: "fraction";
      value: number;
    };

export interface LayoutPreset {
  id: string;
  name: string;
  leftSidebarCollapsed: boolean;
  rightSidebar: {
    collapsed: boolean;
    width: RightSidebarWidthPreset;
    layout: RightSidebarLayoutPresetState;
  };
}

export interface LayoutPresetsConfig {
  version: 1;
  presets: LayoutPreset[];
  slots: LayoutSlot[];
}

export const DEFAULT_LAYOUT_PRESETS_CONFIG: LayoutPresetsConfig = {
  version: 1,
  presets: [],
  slots: [],
};

function isLayoutSlotNumber(value: unknown): value is LayoutSlotNumber {
  return (
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 8 ||
    value === 9
  );
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRightSidebarWidthPreset(raw: unknown): RightSidebarWidthPreset {
  if (!raw || typeof raw !== "object") {
    return { mode: "px", value: 400 };
  }

  const record = raw as Record<string, unknown>;
  const mode = record.mode;

  if (mode === "fraction") {
    const value =
      typeof record.value === "number" && Number.isFinite(record.value) ? record.value : 0.3;
    // Keep in a sensible range (avoid 0px or >100% layouts)
    const clamped = Math.min(0.9, Math.max(0.1, value));
    return { mode: "fraction", value: clamped };
  }

  const value =
    typeof record.value === "number" && Number.isFinite(record.value) ? record.value : 400;
  const rounded = Math.floor(value);
  const clamped = Math.min(1200, Math.max(300, rounded));
  return { mode: "px", value: clamped };
}

function isPresetTabType(value: unknown): value is RightSidebarPresetTabType {
  if (typeof value !== "string") return false;
  if (value === "costs" || value === "review" || value === "explorer" || value === "stats") {
    return true;
  }
  return value.startsWith("terminal_new:") && value.length > "terminal_new:".length;
}

function isLayoutNode(value: unknown): value is RightSidebarLayoutPresetNode {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;

  if (v.type === "tabset") {
    return (
      typeof v.id === "string" &&
      Array.isArray(v.tabs) &&
      v.tabs.every((t) => isPresetTabType(t)) &&
      isPresetTabType(v.activeTab)
    );
  }

  if (v.type === "split") {
    if (typeof v.id !== "string") return false;
    if (v.direction !== "horizontal" && v.direction !== "vertical") return false;
    if (!Array.isArray(v.sizes) || v.sizes.length !== 2) return false;
    if (typeof v.sizes[0] !== "number" || typeof v.sizes[1] !== "number") return false;
    if (!Array.isArray(v.children) || v.children.length !== 2) return false;
    return isLayoutNode(v.children[0]) && isLayoutNode(v.children[1]);
  }

  return false;
}

function findTabset(
  root: RightSidebarLayoutPresetNode,
  tabsetId: string
): RightSidebarLayoutPresetNode | null {
  if (root.type === "tabset") {
    return root.id === tabsetId ? root : null;
  }
  return findTabset(root.children[0], tabsetId) ?? findTabset(root.children[1], tabsetId);
}

function isRightSidebarLayoutPresetState(value: unknown): value is RightSidebarLayoutPresetState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (typeof v.nextId !== "number") return false;
  if (typeof v.focusedTabsetId !== "string") return false;
  if (!isLayoutNode(v.root)) return false;
  return findTabset(v.root, v.focusedTabsetId) !== null;
}

function normalizeLayoutSlot(raw: unknown): LayoutSlot | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;

  if (!isLayoutSlotNumber(record.slot)) {
    return undefined;
  }

  const presetId = normalizeOptionalNonEmptyString(record.presetId);
  const keybindOverride = normalizeKeybind(record.keybindOverride);

  if (!presetId && !keybindOverride) {
    return undefined;
  }

  return {
    slot: record.slot,
    presetId,
    keybindOverride,
  };
}

function normalizeLayoutPreset(raw: unknown): LayoutPreset | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }

  const record = raw as Record<string, unknown>;

  const id = normalizeOptionalNonEmptyString(record.id);
  const name = normalizeOptionalNonEmptyString(record.name);
  if (!id || !name) {
    return undefined;
  }

  const leftSidebarCollapsed =
    typeof record.leftSidebarCollapsed === "boolean" ? record.leftSidebarCollapsed : false;

  if (!record.rightSidebar || typeof record.rightSidebar !== "object") {
    return undefined;
  }

  const rightSidebarRecord = record.rightSidebar as Record<string, unknown>;
  const collapsed =
    typeof rightSidebarRecord.collapsed === "boolean" ? rightSidebarRecord.collapsed : false;
  const width = normalizeRightSidebarWidthPreset(rightSidebarRecord.width);

  const layoutRaw = rightSidebarRecord.layout;
  if (!isRightSidebarLayoutPresetState(layoutRaw)) {
    return undefined;
  }

  const layout: RightSidebarLayoutPresetState = layoutRaw;

  return {
    id,
    name,
    leftSidebarCollapsed,
    rightSidebar: {
      collapsed,
      width,
      layout,
    },
  };
}

export function normalizeLayoutPresetsConfig(raw: unknown): LayoutPresetsConfig {
  if (!raw || typeof raw !== "object") {
    return DEFAULT_LAYOUT_PRESETS_CONFIG;
  }

  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    return DEFAULT_LAYOUT_PRESETS_CONFIG;
  }

  const presetsArray = Array.isArray(record.presets) ? record.presets : [];
  const presetsById = new Map<string, LayoutPreset>();
  for (const entry of presetsArray) {
    const preset = normalizeLayoutPreset(entry);
    if (!preset) continue;
    presetsById.set(preset.id, preset);
  }

  const slotsArray = Array.isArray(record.slots) ? record.slots : [];
  const slotsByNumber = new Map<LayoutSlotNumber, LayoutSlot>();
  for (const entry of slotsArray) {
    const slot = normalizeLayoutSlot(entry);
    if (!slot) continue;

    // Drop presetId references to missing presets (self-healing)
    if (slot.presetId && !presetsById.has(slot.presetId)) {
      if (!slot.keybindOverride) {
        continue;
      }
      slotsByNumber.set(slot.slot, { slot: slot.slot, keybindOverride: slot.keybindOverride });
      continue;
    }

    slotsByNumber.set(slot.slot, slot);
  }

  const presets = Array.from(presetsById.values());
  const slots = Array.from(slotsByNumber.values()).sort((a, b) => a.slot - b.slot);

  const result: LayoutPresetsConfig = {
    version: 1,
    presets,
    slots,
  };

  assert(result.version === 1, "normalizeLayoutPresetsConfig: version must be 1");
  assert(Array.isArray(result.presets), "normalizeLayoutPresetsConfig: presets must be an array");
  assert(Array.isArray(result.slots), "normalizeLayoutPresetsConfig: slots must be an array");

  return result;
}

export function isLayoutPresetsConfigEmpty(value: LayoutPresetsConfig): boolean {
  assert(value.version === 1, "isLayoutPresetsConfigEmpty: version must be 1");

  if (value.presets.length > 0) {
    return false;
  }

  for (const slot of value.slots) {
    if (slot.presetId || slot.keybindOverride) {
      return false;
    }
  }

  return true;
}
