import type { JSX } from "react";
import { createContext, useContext, useMemo } from "react";
import type { PropsWithChildren } from "react";
import { colors, type ThemeColors } from "./colors";
import { spacing, type ThemeSpacing } from "./spacing";
import { typography, type ThemeTypography } from "./typography";
import { assert } from "../utils/assert";

export interface ThemeRadii {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  pill: number;
}

export interface ThemeShadows {
  subtle: {
    shadowColor: string;
    shadowOpacity: number;
    shadowRadius: number;
    shadowOffset: { width: number; height: number };
    elevation: number;
  };
}

export interface Theme {
  colors: ThemeColors;
  spacing: ThemeSpacing;
  typography: ThemeTypography;
  radii: ThemeRadii;
  shadows: ThemeShadows;
  statusBarStyle: "light" | "dark";
}

const radii: ThemeRadii = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
};

const shadows: ThemeShadows = {
  subtle: {
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
};

const baseTheme: Theme = {
  colors,
  spacing,
  typography,
  radii,
  shadows,
  statusBarStyle: "light",
};

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: PropsWithChildren): JSX.Element {
  const memoized = useMemo(() => baseTheme, []);
  return <ThemeContext.Provider value={memoized}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  assert(theme, "useTheme must be used within a ThemeProvider");
  return theme;
}
