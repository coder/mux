import { describe, expect, test } from "bun:test";
import { normalizeLayoutPresetsConfig } from "./uiLayouts";

describe("normalizeLayoutPresetsConfig", () => {
  test("preserves presets that contain legacy explorer tabs", () => {
    const config = normalizeLayoutPresetsConfig({
      version: 2,
      slots: [
        {
          slot: 1,
          preset: {
            id: "preset-1",
            name: "Legacy",
            leftSidebarCollapsed: false,
            rightSidebar: {
              collapsed: false,
              width: { mode: "px", value: 400 },
              layout: {
                version: 1,
                nextId: 2,
                focusedTabsetId: "tabset-1",
                root: {
                  type: "tabset",
                  id: "tabset-1",
                  tabs: ["costs", "explorer", "review"],
                  activeTab: "explorer",
                },
              },
            },
          },
        },
      ],
    });

    const tabset = config.slots[0]?.preset?.rightSidebar.layout.root;
    expect(tabset?.type).toBe("tabset");
    if (tabset?.type !== "tabset") throw new Error("expected tabset");
    expect(tabset.tabs).toEqual(["costs", "review"]);
    expect(tabset.activeTab).toBe("costs");
  });

  test("keeps removed-only preset tabsets usable", () => {
    const config = normalizeLayoutPresetsConfig({
      version: 2,
      slots: [
        {
          slot: 1,
          preset: {
            id: "preset-1",
            name: "Legacy",
            leftSidebarCollapsed: false,
            rightSidebar: {
              collapsed: false,
              width: { mode: "px", value: 400 },
              layout: {
                version: 1,
                nextId: 2,
                focusedTabsetId: "tabset-1",
                root: {
                  type: "tabset",
                  id: "tabset-1",
                  tabs: ["explorer", "file:src/App.tsx"],
                  activeTab: "file:src/App.tsx",
                },
              },
            },
          },
        },
      ],
    });

    const tabset = config.slots[0]?.preset?.rightSidebar.layout.root;
    expect(tabset?.type).toBe("tabset");
    if (tabset?.type !== "tabset") throw new Error("expected tabset");
    expect(tabset.tabs).toEqual(["costs"]);
    expect(tabset.activeTab).toBe("costs");
  });
});
