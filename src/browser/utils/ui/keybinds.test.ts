import { afterEach, describe, it, expect, test } from "bun:test";
import {
  installTestNavigator,
  installTestWindow,
  type TestWindowWithApi,
} from "@/browser/testUtils";
import { isMac, matchesKeybind, KEYBINDS } from "./keybinds";
import type { Keybind } from "@/common/types/keybind";

let testWindow: TestWindowWithApi | undefined;
let restoreTestWindow: (() => void) | undefined;
let restoreTestNavigator: (() => void) | undefined;

function setPlatform(platform: "darwin" | "linux") {
  Object.defineProperty(ensureWindow(), "api", {
    configurable: true,
    value: { platform },
  });
}

function clearWindowAPI() {
  delete ensureWindow().api;
}

function ensureWindow(): TestWindowWithApi {
  if (!testWindow) {
    const installedWindow = installTestWindow();
    testWindow = installedWindow.window;
    restoreTestWindow = installedWindow.restore;
  }

  return testWindow;
}

function setNavigatorPlatform(platform: string) {
  restoreTestNavigator = installTestNavigator({
    platform,
    userAgent: "Mozilla/5.0",
  } as unknown as Navigator);
}

afterEach(() => {
  restoreTestNavigator?.();
  restoreTestWindow?.();
  testWindow = undefined;
  restoreTestWindow = undefined;
  restoreTestNavigator = undefined;
});

// Helper to create a minimal keyboard event
function createEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return {
    key: "a",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("isMac", () => {
  it("falls back to navigator.platform when Electron API is missing", () => {
    clearWindowAPI();
    setNavigatorPlatform("MacIntel");

    expect(isMac()).toBe(true);

    // Ctrl-style keybinds should match Cmd (Meta) on macOS
    const event = createEvent({ key: "P", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);
  });
});

describe("CYCLE_MODEL keybind (Ctrl+/)", () => {
  it("matches Ctrl+/ on Linux/Windows", () => {
    // Mock non-Mac platform
    setPlatform("linux");
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Cmd+/ on macOS", () => {
    // Mock Mac platform
    setPlatform("darwin");
    const event = createEvent({ key: "/", metaKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("matches Ctrl+/ on macOS (either behavior)", () => {
    // Mock Mac platform
    setPlatform("darwin");
    const event = createEvent({ key: "/", ctrlKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(true);
  });

  it("does not match just /", () => {
    const event = createEvent({ key: "/" });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });

  it("does not match Ctrl+? (shifted /)", () => {
    const event = createEvent({ key: "?", ctrlKey: true, shiftKey: true });
    expect(matchesKeybind(event, { key: "/", ctrl: true })).toBe(false);
  });
});

describe("CYCLE_AGENT keybind (Ctrl/Cmd+.)", () => {
  it("matches Cmd+. on macOS via the Period key code", () => {
    setPlatform("darwin");
    const event = createEvent({ key: ".", code: "Period", metaKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });

  it("matches Cmd+Shift+Period on layouts where Period requires Shift", () => {
    setPlatform("darwin");
    const event = createEvent({ key: ">", code: "Period", metaKey: true, shiftKey: true });
    expect(matchesKeybind(event, KEYBINDS.CYCLE_AGENT)).toBe(true);
  });
});

test("removed auto agent toggle keybind", () => {
  const removedKey = ["TOGGLE", "AUTO", "AGENT"].join("_");
  expect(KEYBINDS).not.toHaveProperty(removedKey);
});

describe("SEND_MESSAGE_AFTER_TURN keybind (Ctrl/Cmd+Enter)", () => {
  it("matches Ctrl+Enter", () => {
    setPlatform("linux");
    const event = createEvent({ key: "Enter", ctrlKey: true, metaKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("matches Cmd+Enter on macOS", () => {
    setPlatform("darwin");
    const event = createEvent({ key: "Enter", metaKey: true, ctrlKey: false });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(true);
  });

  it("does not match plain Enter", () => {
    setPlatform("linux");
    const event = createEvent({ key: "Enter" });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE_AFTER_TURN)).toBe(false);
  });

  it("SEND_MESSAGE does not match Ctrl+Enter", () => {
    setPlatform("linux");
    const event = createEvent({ key: "Enter", ctrlKey: true });
    expect(matchesKeybind(event, KEYBINDS.SEND_MESSAGE)).toBe(false);
  });
});

describe("matchesKeybind", () => {
  describe("FOCUS_REVIEW_SEARCH_QUICK keybind (/)", () => {
    it("matches Shift+/ when event.key is /", () => {
      const event = createEvent({ key: "/", shiftKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("matches plain /", () => {
      const event = createEvent({ key: "/" });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(true);
    });

    it("does not match Ctrl+/", () => {
      const event = createEvent({ key: "/", ctrlKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });

    it("does not match Cmd+/", () => {
      const event = createEvent({ key: "/", metaKey: true });
      expect(matchesKeybind(event, KEYBINDS.FOCUS_REVIEW_SEARCH_QUICK)).toBe(false);
    });
  });

  it("should return false when event.key is undefined", () => {
    // This can happen with dead keys, modifier-only events, etc.
    const event = createEvent({ key: undefined as unknown as string });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should return false when event.key is empty string", () => {
    const event = createEvent({ key: "" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match simple key press", () => {
    const event = createEvent({ key: "a" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match case-insensitively", () => {
    const event = createEvent({ key: "A" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match different key", () => {
    const event = createEvent({ key: "b" });
    const keybind: Keybind = { key: "a" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Ctrl+key combination", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should not match when Ctrl is required but not pressed", () => {
    const event = createEvent({ key: "n", ctrlKey: false });
    const keybind: Keybind = { key: "n", ctrl: true };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should not match when Ctrl is pressed but not required", () => {
    const event = createEvent({ key: "n", ctrlKey: true });
    const keybind: Keybind = { key: "n" };

    expect(matchesKeybind(event, keybind)).toBe(false);
  });

  it("should match Shift+key combination", () => {
    const event = createEvent({ key: "G", shiftKey: true });
    const keybind: Keybind = { key: "G", shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Alt+key combination", () => {
    const event = createEvent({ key: "a", altKey: true });
    const keybind: Keybind = { key: "a", alt: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });

  it("should match Ctrl/Cmd+Shift+P for OPEN_COMMAND_PALETTE", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE)).toBe(true);
  });

  it("should match F4 for OPEN_COMMAND_PALETTE_ACTIONS", () => {
    const event = createEvent({ key: "F4" });

    expect(matchesKeybind(event, KEYBINDS.OPEN_COMMAND_PALETTE_ACTIONS)).toBe(true);
  });

  it("should match complex multi-modifier combination", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });
    const keybind: Keybind = { key: "P", ctrl: true, shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });
});
