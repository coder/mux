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

/** User's theme selection (includes "system" for OS-matching) */
export type ThemeMode = "system" | "light" | "dark" | "flexoki-light" | "flexoki-dark";

/** Concrete theme applied to the document (never "system") */
export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "flexoki-light", label: "Flexoki Light" },
  { value: "flexoki-dark", label: "Flexoki Dark" },
];

const THEME_VALUES = THEME_OPTIONS.map((t) => t.value);

function normalizeTheme(value: unknown): ThemeMode {
  if (typeof value === "string" && THEME_VALUES.includes(value as ThemeMode)) {
    return value as ThemeMode;
  }
  // Self-heal: unknown/legacy values become "system"
  return "system";
}

interface ThemeContextValue {
  /** The user's theme selection (system, light, dark, etc.) */
  theme: ThemeMode;
  /** The resolved theme applied to the document (never "system") */
  resolvedTheme: ResolvedThemeMode;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  /** True if this provider has a forcedTheme - nested providers should not override */
  isForced: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const THEME_COLORS: Record<ResolvedThemeMode, string> = {
  dark: "#1e1e1e",
  light: "#f5f6f8",
  "flexoki-light": "#fffcf0",
  "flexoki-dark": "#100f0f",
};

/** Map theme mode to CSS color-scheme value */
function getColorScheme(theme: ResolvedThemeMode): "light" | "dark" {
  return theme === "light" || theme === "flexoki-light" ? "light" : "dark";
}

function getSystemTheme(): ResolvedThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyThemeToDocument(theme: ResolvedThemeMode) {
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
  forcedTheme?: ResolvedThemeMode;
}) {
  // Check if we're nested inside a forced theme provider
  const parentContext = useContext(ThemeContext);
  const isNestedUnderForcedProvider = parentContext?.isForced ?? false;

  // Track OS theme for "system" preference
  const [systemTheme, setSystemTheme] = useState<ResolvedThemeMode>(getSystemTheme);

  // Persist the user's theme selection
  const [rawTheme, setRawTheme] = usePersistedState<ThemeMode>(UI_THEME_KEY, "system", {
    listener: true,
  });

  const theme = normalizeTheme(rawTheme);

  // Self-heal invalid persisted values
  useEffect(() => {
    if (rawTheme !== theme) {
      setRawTheme(theme);
    }
  }, [rawTheme, theme, setRawTheme]);

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

  // Resolve the actual theme to apply (never "system")
  const resolved: ResolvedThemeMode =
    theme === "system" ? systemTheme : (theme as ResolvedThemeMode);

  // If nested under a forced provider, use parent's resolved theme
  // Otherwise, use forcedTheme (if provided) or resolved preference
  const resolvedTheme: ResolvedThemeMode =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.resolvedTheme
      : (forcedTheme ?? resolved);

  const isForced = forcedTheme !== undefined || isNestedUnderForcedProvider;

  // Apply theme to document (authoritative provider only)
  useLayoutEffect(() => {
    if (!isNestedUnderForcedProvider) {
      applyThemeToDocument(resolvedTheme);
    }
  }, [resolvedTheme, isNestedUnderForcedProvider]);

  const setTheme = useCallback(
    (newTheme: ThemeMode) => {
      if (!isNestedUnderForcedProvider) {
        setRawTheme(newTheme);
      }
    },
    [setRawTheme, isNestedUnderForcedProvider]
  );

  // Toggle between light and dark variants of the current theme family.
  // This gives intuitive behavior: if it looks light, toggle to dark (and vice versa).
  const toggleTheme = useCallback(() => {
    if (!isNestedUnderForcedProvider) {
      const themeMap: Record<ResolvedThemeMode, ResolvedThemeMode> = {
        light: "dark",
        dark: "light",
        "flexoki-light": "flexoki-dark",
        "flexoki-dark": "flexoki-light",
      };
      setRawTheme(themeMap[resolvedTheme]);
    }
  }, [resolvedTheme, setRawTheme, isNestedUnderForcedProvider]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
      isForced,
    }),
    [theme, resolvedTheme, setTheme, toggleTheme, isForced]
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
