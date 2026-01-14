import { GlobalWindow } from "happy-dom";

// Setup basic DOM environment for testing-library
const dom = new GlobalWindow();
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).location = new URL("https://example.com/");
// Polyfill console since happy-dom might interfere or we just want standard console
(global as any).console = console;
/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access */

import { afterEach, describe, expect, mock, test, beforeEach } from "bun:test";

import { render, cleanup } from "@testing-library/react";
import React from "react";
import { ThemeProvider, useTheme } from "./ThemeContext";
import { UI_THEME_KEY } from "@/common/constants/storage";

// Helper to access internals
const TestComponent = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <button onClick={toggleTheme} data-testid="toggle-btn">
        Toggle
      </button>
    </div>
  );
};

describe("ThemeContext", () => {
  // Mock matchMedia
  const mockMatchMedia = mock(() => ({
    matches: false,
    media: "",
    onchange: null,
    addListener: () => {
      // no-op
    },
    removeListener: () => {
      // no-op
    },
    addEventListener: () => {
      // no-op
    },
    removeEventListener: () => {
      // no-op
    },
    dispatchEvent: () => true,
  }));

  beforeEach(() => {
    // Ensure window exists (Bun test with happy-dom should provide it)
    if (typeof window !== "undefined") {
      window.matchMedia = mockMatchMedia;
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    cleanup();
    if (typeof window !== "undefined") {
      window.localStorage.clear();
    }
  });

  test("uses persisted state by default", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );
    // If matchMedia matches is false (default mock), resolveSystemTheme returns 'dark' (since it checks prefers-color-scheme: light)
    // resolveSystemTheme logic: window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"
    expect(getByTestId("theme-value").textContent).toBe("dark");
  });

  test("respects forcedTheme prop", () => {
    const { getByTestId, rerender } = render(
      <ThemeProvider forcedTheme="light">
        <TestComponent />
      </ThemeProvider>
    );
    expect(getByTestId("theme-value").textContent).toBe("light");

    rerender(
      <ThemeProvider forcedTheme="dark">
        <TestComponent />
      </ThemeProvider>
    );
    expect(getByTestId("theme-value").textContent).toBe("dark");
  });

  test("forcedTheme overrides persisted state", () => {
    window.localStorage.setItem(UI_THEME_KEY, JSON.stringify("light"));

    const { getByTestId } = render(
      <ThemeProvider forcedTheme="dark">
        <TestComponent />
      </ThemeProvider>
    );
    expect(getByTestId("theme-value").textContent).toBe("dark");

    // Check that localStorage is still light (since forcedTheme doesn't write to storage by itself)
    expect(JSON.parse(window.localStorage.getItem(UI_THEME_KEY)!)).toBe("light");
  });
});
