/**
 * Chrome colors for surfaces that cannot read CSS variables: the Electron titlebar overlay (main
 * process) and the `theme-color` meta tag. Each value mirrors `--color-surface-primary` for that
 * theme in `src/browser/styles/globals.css`; update both together.
 */
export const CHROME_COLORS = {
  dark: "#09090b",
  light: "#ffffff",
  "flexoki-light": "#fffcf0",
  "flexoki-dark": "#100f0f",
} as const;

/** The window is created before the renderer resolves a theme, so native chrome starts dark. */
export const DEFAULT_CHROME_COLOR = CHROME_COLORS.dark;

export const TITLEBAR_SYMBOL_COLOR = "#a3a3a3";
