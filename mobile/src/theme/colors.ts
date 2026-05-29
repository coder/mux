export const colors = {
  background: "#1f1f1f", // matches --color-background
  surface: "#252526", // sidebar background
  surfaceSecondary: "#2a2a2b", // header/footer backgrounds
  surfaceElevated: "#2a2a2b", // hover/raised surfaces
  surfaceSunken: "#161616", // deeper backgrounds
  border: "#3e3e42",
  borderSubtle: "#2a2a2b",
  separator: "#2d2d30",
  foregroundPrimary: "#d4d4d4",
  foregroundSecondary: "#9a9a9a",
  foregroundMuted: "#6e6e6e",
  foregroundInverted: "#0b0b0c",
  accent: "#007acc",
  accentHover: "#1177bb",
  accentMuted: "rgba(17, 119, 187, 0.08)",
  warning: "#ffc107",
  danger: "#f44336",
  success: "#4caf50",
  successBackground: "#e6ffec",
  error: "#f44336",
  errorBackground: "#ffeef0",
  info: "#3794ff",
  foregroundTertiary: "#6e6e6e",
  overlay: "rgba(0, 0, 0, 0.4)",
  inputBackground: "#1f1f1f",
  inputBorder: "#3e3e42",
  inputBorderFocused: "#4db8ff",
  chipBackground: "rgba(17, 119, 187, 0.16)",
  chipBorder: "rgba(17, 119, 187, 0.4)",
  backdrop: "rgba(10, 10, 10, 0.72)",

  // Mode colors (matching web/Electron src/styles/globals.css)
  // Plan Mode - blue (hsl(210 70% 40%) = #1f6bb8)
  planMode: "#1f6bb8",
  planModeHover: "#3b87c7", // hsl(210 70% 52%)
  planModeLight: "#6ba7dc", // hsl(210 70% 68%)
  planModeAlpha: "rgba(31, 107, 184, 0.1)",

  // Exec Mode - purple (hsl(268.56 94.04% 55.19%) = #a855f7)
  execMode: "#a855f7",
  execModeHover: "#b97aff", // hsl(268.56 94.04% 67%)
  execModeLight: "#d0a3ff", // hsl(268.56 94.04% 78%)

  // Edit Mode - green (hsl(120 50% 35%) = #2e8b2e)
  editMode: "#2e8b2e",
  editModeHover: "#3ea03e", // hsl(120 50% 47%)
  editModeLight: "#5ec15e", // hsl(120 50% 62%)

  // Thinking Mode - purple (hsl(271 76% 53%) = #9333ea)
  thinkingMode: "#9333ea",
  thinkingModeLight: "#a855f7", // hsl(271 76% 65%)
  thinkingBorder: "#9333ea", // hsl(271 76% 53%)

  // Other mode colors
  editingMode: "#ff8800", // hsl(30 100% 50%)
  editingModeAlpha: "rgba(255, 136, 0, 0.1)",
  pendingMode: "#ffb84d", // hsl(30 100% 70%)
  debugMode: "#4da6ff", // hsl(214 100% 64%)
} as const;

export type ThemeColors = typeof colors;
