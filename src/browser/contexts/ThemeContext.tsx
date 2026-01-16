import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { UI_THEME_KEY } from "@/common/constants/storage";

/** Concrete theme applied to the document */
export type ThemeMode = "light" | "dark";

/** User preference: explicit theme or follow system */
export type ThemePreference = ThemeMode | "system";

export const THEME_PREFERENCE_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const PREFERENCE_VALUES = THEME_PREFERENCE_OPTIONS.map((t) => t.value);

function normalizeThemePreference(value: unknown): ThemePreference {
  if (typeof value === "string" && PREFERENCE_VALUES.includes(value as ThemePreference)) {
    return value as ThemePreference;
  }
  // Self-heal: unknown/legacy values become "system"
  return "system";
}

interface ThemeContextValue {
  /** The resolved theme applied to the document */
  theme: ThemeMode;
  /** The user's preference (system, light, or dark) */
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
  /** True if this provider has a forcedTheme - nested providers should not override */
  isForced: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_COLORS: Record<ThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#f5f6f8",
};

function getSystemTheme(): ThemeMode {
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
  root.style.colorScheme = theme;

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

  // Track OS theme for "system" preference
  const [systemTheme, setSystemTheme] = useState<ThemeMode>(getSystemTheme);

  // Persist the user's preference (system | light | dark)
  const [rawPreference, setRawPreference] = usePersistedState<ThemePreference>(
    UI_THEME_KEY,
    "system",
    { listener: true }
  );

  const themePreference = normalizeThemePreference(rawPreference);

  // Self-heal invalid persisted values
  useEffect(() => {
    if (rawPreference !== themePreference) {
      setRawPreference(themePreference);
    }
  }, [rawPreference, themePreference, setRawPreference]);

  // Subscribe to OS theme changes (only when authoritative provider)
  useEffect(() => {
    if (isNestedUnderForcedProvider || typeof window === "undefined" || !window.matchMedia) {
      return;
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: light)");
    const handleChange = () => {
      setSystemTheme(mediaQuery.matches ? "light" : "dark");
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [isNestedUnderForcedProvider]);

  // Resolve the actual theme to apply
  const resolvedTheme: ThemeMode = themePreference === "system" ? systemTheme : themePreference;

  // If nested under a forced provider, use parent's theme
  // Otherwise, use forcedTheme (if provided) or resolved preference
  const theme =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.theme
      : (forcedTheme ?? resolvedTheme);

  const isForced = forcedTheme !== undefined || isNestedUnderForcedProvider;

  // Apply theme to document (authoritative provider only)
  useLayoutEffect(() => {
    if (!isNestedUnderForcedProvider) {
      applyThemeToDocument(theme);
    }
  }, [theme, isNestedUnderForcedProvider]);

  const setThemePreference = useCallback(
    (preference: ThemePreference) => {
      if (!isNestedUnderForcedProvider) {
        setRawPreference(preference);
      }
    },
    [setRawPreference, isNestedUnderForcedProvider]
  );

  // Toggle between light and dark based on current resolved theme.
  // This gives intuitive behavior: if it looks light, toggle to dark (and vice versa).
  const toggleTheme = useCallback(() => {
    if (!isNestedUnderForcedProvider) {
      setRawPreference(theme === "light" ? "dark" : "light");
    }
  }, [theme, setRawPreference, isNestedUnderForcedProvider]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      themePreference,
      setThemePreference,
      toggleTheme,
      isForced,
    }),
    [theme, themePreference, setThemePreference, toggleTheme, isForced]
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
