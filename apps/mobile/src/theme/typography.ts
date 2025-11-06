export const typography = {
  familyPrimary:
    "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Helvetica Neue', Arial, sans-serif",
  familyMono: "'Menlo', 'Roboto Mono', 'Courier New', monospace",
  sizes: {
    titleLarge: 24,
    titleMedium: 20,
    titleSmall: 18,
    body: 15,
    label: 13,
    caption: 12,
    micro: 10,
  },
  weights: {
    regular: "400" as const,
    medium: "500" as const,
    semibold: "600" as const,
    bold: "700" as const,
  },
  lineHeights: {
    tight: 18,
    snug: 20,
    normal: 22,
    relaxed: 26,
  },
} as const;

export type ThemeTypography = typeof typography;
