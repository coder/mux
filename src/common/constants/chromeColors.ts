/**
 * Chrome colors for surfaces that cannot read CSS variables: the Electron titlebar overlay (main
 * process), the `theme-color` meta tag, and the PWA manifest. They all sit against the app's chrome,
 * so each value mirrors that theme's `--color-sidebar` in `src/browser/styles/globals.css`. Only the
 * dark theme resolves that to the page fill, per the Review 1.4 design.
 */
export const CHROME_COLORS = {
  dark: "#09090b",
  light: "#f5f5f5",
  "flexoki-light": "#f2f0e5",
  "flexoki-dark": "#1c1b1a",
} as const;

/** The window is created before the renderer resolves a theme, so native chrome starts dark. */
export const DEFAULT_CHROME_COLOR = CHROME_COLORS.dark;

export const TITLEBAR_SYMBOL_COLOR = "#a3a3a3";
