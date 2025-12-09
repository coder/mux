import type { JSX } from "react";
import type { TextProps, TextStyle } from "react-native";
import { Text } from "react-native";
import { useMemo } from "react";
import { useTheme } from "../theme";
import type { Theme } from "../theme";
import { assert } from "../utils/assert";

export type TextVariant =
  | "titleLarge"
  | "titleMedium"
  | "titleSmall"
  | "body"
  | "label"
  | "caption"
  | "mono"
  | "monoMuted"
  | "muted"
  | "accent";

export interface ThemedTextProps extends TextProps {
  variant?: TextVariant;
  weight?: "regular" | "medium" | "semibold" | "bold";
  align?: "auto" | "left" | "right" | "center" | "justify";
}

const VARIANT_MAPPER: Record<TextVariant, (theme: Theme) => TextStyle> = {
  titleLarge: (theme) => ({
    fontSize: theme.typography.sizes.titleLarge,
    lineHeight: theme.typography.lineHeights.relaxed,
    fontWeight: theme.typography.weights.bold,
    color: theme.colors.foregroundPrimary,
  }),
  titleMedium: (theme) => ({
    fontSize: theme.typography.sizes.titleMedium,
    lineHeight: theme.typography.lineHeights.relaxed,
    fontWeight: theme.typography.weights.semibold,
    color: theme.colors.foregroundPrimary,
  }),
  titleSmall: (theme) => ({
    fontSize: theme.typography.sizes.titleSmall,
    lineHeight: theme.typography.lineHeights.snug,
    fontWeight: theme.typography.weights.semibold,
    color: theme.colors.foregroundPrimary,
  }),
  body: (theme) => ({
    fontSize: theme.typography.sizes.body,
    lineHeight: theme.typography.lineHeights.normal,
    fontWeight: theme.typography.weights.regular,
    color: theme.colors.foregroundPrimary,
  }),
  label: (theme) => ({
    fontSize: theme.typography.sizes.label,
    lineHeight: theme.typography.lineHeights.snug,
    fontWeight: theme.typography.weights.medium,
    color: theme.colors.foregroundSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  }),
  caption: (theme) => ({
    fontSize: theme.typography.sizes.caption,
    lineHeight: theme.typography.lineHeights.tight,
    color: theme.colors.foregroundMuted,
  }),
  mono: (theme) => ({
    fontSize: theme.typography.sizes.caption,
    fontFamily: theme.typography.familyMono,
    lineHeight: theme.typography.lineHeights.tight,
    color: theme.colors.foregroundSecondary,
  }),
  monoMuted: (theme) => ({
    fontSize: theme.typography.sizes.caption,
    fontFamily: theme.typography.familyMono,
    lineHeight: theme.typography.lineHeights.tight,
    color: theme.colors.foregroundMuted,
  }),
  muted: (theme) => ({
    fontSize: theme.typography.sizes.body,
    lineHeight: theme.typography.lineHeights.normal,
    color: theme.colors.foregroundMuted,
  }),
  accent: (theme) => ({
    fontSize: theme.typography.sizes.body,
    lineHeight: theme.typography.lineHeights.normal,
    color: theme.colors.accent,
    fontWeight: theme.typography.weights.medium,
  }),
};

export function ThemedText({
  variant = "body",
  weight,
  align,
  style,
  children,
  ...rest
}: ThemedTextProps): JSX.Element {
  const theme = useTheme();
  const variantStyle = useMemo(() => {
    const mapper = VARIANT_MAPPER[variant];
    assert(mapper, `Unsupported text variant: ${variant}`);
    return mapper(theme);
  }, [theme, variant]);

  const weightStyle: TextStyle | undefined = weight
    ? { fontWeight: theme.typography.weights[weight] }
    : undefined;

  const alignStyle: TextStyle | undefined = align ? { textAlign: align } : undefined;

  return (
    <Text
      style={[
        {
          fontFamily: theme.typography.familyPrimary,
          color: theme.colors.foregroundPrimary,
        },
        variantStyle,
        weightStyle,
        alignStyle,
        style,
      ]}
      {...rest}
    >
      {children}
    </Text>
  );
}
