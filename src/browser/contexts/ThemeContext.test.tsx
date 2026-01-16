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
  const { theme, resolvedTheme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button onClick={toggleTheme}>Toggle</button>
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

  test("defaults to system theme", () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <TestComponent />
      </ThemeProvider>
    );
    // Default is "system", which resolves to "dark" when matchMedia returns false for prefers-color-scheme: light
    expect(getByTestId("theme").textContent).toBe("system");
    expect(getByTestId("resolved").textContent).toBe("dark");
  });

  test("forcedTheme overrides resolved theme without changing preference", () => {
    window.localStorage.setItem(UI_THEME_KEY, JSON.stringify("light"));
    const { getByTestId } = render(
      <ThemeProvider forcedTheme="dark">
        <TestComponent />
      </ThemeProvider>
    );
    // Preference unchanged, but resolved theme is forced
    expect(getByTestId("theme").textContent).toBe("light");
    expect(getByTestId("resolved").textContent).toBe("dark");
  });
});
