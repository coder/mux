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

export type ThemeMode = "light" | "dark" | "flexoki-light" | "flexoki-dark";

export const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "flexoki-light", label: "Flexoki Light" },
  { value: "flexoki-dark", label: "Flexoki Dark" },
];

const THEME_VALUES = THEME_OPTIONS.map((t) => t.value);

function normalizeThemeMode(value: unknown): ThemeMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (THEME_VALUES.includes(value as ThemeMode)) {
    return value as ThemeMode;
  }

  // Preserve intent for removed themes (e.g. legacy solarized-light/dark).
  if (value.endsWith("-light")) {
    return "light";
  }

  if (value.endsWith("-dark")) {
    return "dark";
  }

  return undefined;
}

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
  "flexoki-light": "#fffcf0",
  "flexoki-dark": "#100f0f",
};

const FAVICON_BY_SCHEME: Record<"light" | "dark", string> = {
  light: "/favicon.ico",
  dark: "/favicon-dark.ico",
};

/** Map theme mode to CSS color-scheme value */
function getColorScheme(theme: ThemeMode): "light" | "dark" {
  return theme === "light" || theme === "flexoki-light" ? "light" : "dark";
}

function applyThemeFavicon(theme: ThemeMode) {
  if (typeof document === "undefined") {
    return;
  }

  const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-theme-icon]');
  if (!favicon) {
    return;
  }

  const scheme = getColorScheme(theme);
  const nextHref = FAVICON_BY_SCHEME[scheme];
  if (favicon.getAttribute("href") !== nextHref) {
    favicon.setAttribute("href", nextHref);
  }
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

  applyThemeFavicon(theme);
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

  const parsedPersistedTheme = normalizeThemeMode(persistedTheme);
  const normalizedPersistedTheme = parsedPersistedTheme ?? resolveSystemTheme();

  // If nested under a forced provider, use parent's theme
  // Otherwise, use forcedTheme (if provided) or persistedTheme
  const theme =
    isNestedUnderForcedProvider && parentContext
      ? parentContext.theme
      : (forcedTheme ?? normalizedPersistedTheme);

  const isForced = forcedTheme !== undefined || isNestedUnderForcedProvider;

  // Only apply to document if we're the authoritative provider
  useLayoutEffect(() => {
    if (isNestedUnderForcedProvider) {
      return;
    }

    // Self-heal legacy or invalid themes persisted in localStorage.
    if (forcedTheme === undefined && parsedPersistedTheme !== persistedTheme) {
      setTheme(normalizedPersistedTheme);
    }

    applyThemeToDocument(theme);
  }, [
    forcedTheme,
    isNestedUnderForcedProvider,
    normalizedPersistedTheme,
    parsedPersistedTheme,
    persistedTheme,
    setTheme,
    theme,
  ]);

  const toggleTheme = useCallback(() => {
    if (!isNestedUnderForcedProvider) {
      setTheme((current) => {
        const currentIndex = THEME_VALUES.indexOf(current);
        const nextIndex = (currentIndex + 1) % THEME_VALUES.length;
        return THEME_VALUES[nextIndex];
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
