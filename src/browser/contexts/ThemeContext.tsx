import React, {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { UI_THEME_KEY } from "@/common/constants/storage";

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
  /** True if this provider has a forcedTheme - nested providers should not override */
  isForced: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_COLORS: Record<ThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#f5f6f8",
  "solarized-light": "#fdf6e3",
  "solarized-dark": "#002b36",
};

/** Map theme mode to CSS color-scheme value */
function getColorScheme(theme: ThemeMode): "light" | "dark" {
  return theme === "light" || theme === "solarized-light" ? "light" : "dark";
}

function resolveSystemTheme(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyThemeToDocument(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = getColorScheme(theme);

  const themeColor = THEME_COLORS[theme];
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", themeColor);
  }

  const body = document.body;
  if (body) {
    body.style.backgroundColor = "var(--color-background)";
  }
}

export function ThemeProvider({
  children,
  forcedTheme,
}: {
  children: ReactNode;
  forcedTheme?: ThemeMode;
}) {
  // Check if we're nested inside a forced theme provider
  const parentContext = useContext(ThemeContext);
  const isNestedUnderForcedProvider = parentContext?.isForced ?? false;

  const [persistedTheme, setTheme] = usePersistedState<ThemeMode>(
    UI_THEME_KEY,
    resolveSystemTheme(),
    {
      listener: true,
    }
  );

  // If nested under a forced provider, use parent's theme
  // Otherwise, use forcedTheme (if provided) or persistedTheme
  const theme =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.theme
      : (forcedTheme ?? persistedTheme);

  const isForced = forcedTheme !== undefined || isNestedUnderForcedProvider;

  // Only apply to document if we're the authoritative provider
  useLayoutEffect(() => {
    if (!isNestedUnderForcedProvider) {
      applyThemeToDocument(theme);
    }
  }, [theme, isNestedUnderForcedProvider]);

  const toggleTheme = useCallback(() => {
    if (!isNestedUnderForcedProvider) {
      setTheme((current) => {
        const themeValues = THEME_OPTIONS.map((t) => t.value);
        const currentIndex = themeValues.indexOf(current);
        const nextIndex = (currentIndex + 1) % themeValues.length;
        return themeValues[nextIndex];
      });
    }
  }, [setTheme, isNestedUnderForcedProvider]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme,
      toggleTheme,
      isForced,
    }),
    [setTheme, theme, toggleTheme, isForced]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
