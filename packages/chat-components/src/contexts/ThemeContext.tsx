import React, { createContext, useContext, useLayoutEffect, type ReactNode } from "react";

export type ThemeMode = "light" | "dark" | "solarized-light" | "solarized-dark";

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "solarized-light", label: "Solarized Light" },
  { value: "solarized-dark", label: "Solarized Dark" },
];

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: React.Dispatch<React.SetStateAction<ThemeMode>>;
  toggleTheme: () => void;
  isForced: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_COLORS: Record<ThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#f5f6f8",
  "solarized-light": "#fdf6e3",
  "solarized-dark": "#002b36",
};

function getColorScheme(theme: ThemeMode): "light" | "dark" {
  return theme === "light" || theme === "solarized-light" ? "light" : "dark";
}

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: ThemeMode;
  forcedTheme?: ThemeMode;
}

/**
 * Minimal theme provider for shared components.
 * For mux.md viewer, use forcedTheme to match the host app's theme.
 */
export function ThemeProvider({
  children,
  defaultTheme = "dark",
  forcedTheme,
}: ThemeProviderProps): React.JSX.Element {
  const [theme, setTheme] = React.useState<ThemeMode>(forcedTheme ?? defaultTheme);

  // Apply theme to document
  useLayoutEffect(() => {
    const activeTheme = forcedTheme ?? theme;
    const root = document.documentElement;

    // Remove existing theme classes
    THEME_OPTIONS.forEach(({ value }) => {
      root.classList.remove(value);
    });

    // Add current theme class
    root.classList.add(activeTheme);

    // Set color scheme for native elements
    root.style.setProperty("color-scheme", getColorScheme(activeTheme));

    // Set meta theme-color
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta.setAttribute("content", THEME_COLORS[activeTheme]);
  }, [theme, forcedTheme]);

  const toggleTheme = React.useCallback(() => {
    if (forcedTheme) return;
    setTheme((prev) => {
      const idx = THEME_OPTIONS.findIndex((o) => o.value === prev);
      return THEME_OPTIONS[(idx + 1) % THEME_OPTIONS.length].value;
    });
  }, [forcedTheme]);

  const value: ThemeContextValue = {
    theme: forcedTheme ?? theme,
    setTheme: forcedTheme ? () => {} : setTheme,
    toggleTheme,
    isForced: !!forcedTheme,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}
