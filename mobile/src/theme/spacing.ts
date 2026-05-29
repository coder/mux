export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  triple: 48,
} as const;

export type ThemeSpacing = typeof spacing;

export function spacingFor(multiplier: number): number {
  return spacing.sm * multiplier;
}
