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
  info: "#3794ff",
  overlay: "rgba(0, 0, 0, 0.4)",
  inputBackground: "#1f1f1f",
  inputBorder: "#3e3e42",
  inputBorderFocused: "#4db8ff",
  chipBackground: "rgba(17, 119, 187, 0.16)",
  chipBorder: "rgba(17, 119, 187, 0.4)",
  backdrop: "rgba(10, 10, 10, 0.72)",
} as const;

export type ThemeColors = typeof colors;
