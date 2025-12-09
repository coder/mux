import { describe, it, expect } from "bun:test";
import { matchesKeybind, type Keybind } from "./keybinds";

describe("matchesKeybind", () => {
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

  it("should match complex multi-modifier combination", () => {
    const event = createEvent({ key: "P", ctrlKey: true, shiftKey: true });
    const keybind: Keybind = { key: "P", ctrl: true, shift: true };

    expect(matchesKeybind(event, keybind)).toBe(true);
  });
});
