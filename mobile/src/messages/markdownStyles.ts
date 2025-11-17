import { StyleSheet } from "react-native";
import type { MarkdownProps } from "react-native-markdown-display";
import type { Theme } from "../theme";
import { assert } from "../utils/assert";

export type MarkdownVariant = "assistant" | "reasoning" | "plan";
export type MarkdownStyle = NonNullable<MarkdownProps["style"]>;

type VariantColorResolver = (theme: Theme) => string;

const BLOCKQUOTE_COLORS: Record<MarkdownVariant, VariantColorResolver> = {
  assistant: (theme) => theme.colors.accent,
  reasoning: (theme) => theme.colors.thinkingMode,
  plan: (theme) => theme.colors.planMode,
};

const CODE_INLINE_BG: Record<MarkdownVariant, VariantColorResolver> = {
  assistant: (theme) => theme.colors.surfaceSunken,
  reasoning: (theme) => theme.colors.surfaceSunken,
  plan: () => "rgba(31, 107, 184, 0.15)",
};

const CODE_INLINE_TEXT: Record<MarkdownVariant, VariantColorResolver> = {
  assistant: (theme) => theme.colors.foregroundPrimary,
  reasoning: (theme) => theme.colors.foregroundPrimary,
  plan: (theme) => theme.colors.planModeLight,
};

const HEADING_COLORS: Record<MarkdownVariant, VariantColorResolver> = {
  assistant: (theme) => theme.colors.foregroundPrimary,
  reasoning: (theme) => theme.colors.foregroundPrimary,
  plan: (theme) => theme.colors.planModeLight,
};

const BODY_COLORS: Record<MarkdownVariant, VariantColorResolver> = {
  assistant: (theme) => theme.colors.foregroundPrimary,
  reasoning: (theme) => theme.colors.foregroundSecondary,
  plan: (theme) => theme.colors.foregroundPrimary,
};

export function createMarkdownStyles(theme: Theme, variant: MarkdownVariant): MarkdownStyle {
  assert(variant in BLOCKQUOTE_COLORS, `Unknown markdown variant: ${variant}`);

  const headingColor = HEADING_COLORS[variant](theme);

  return {
    body: {
      color: BODY_COLORS[variant](theme),
      fontFamily: theme.typography.familyPrimary,
      fontSize: theme.typography.sizes.body,
      lineHeight: theme.typography.lineHeights.normal,
      fontStyle: variant === "reasoning" ? "italic" : "normal",
    },
    code_block: {
      backgroundColor: theme.colors.surfaceSunken,
      borderRadius: theme.radii.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.separator,
      padding: theme.spacing.sm,
      fontFamily: theme.typography.familyMono,
      fontSize: theme.typography.sizes.caption,
      color: theme.colors.foregroundPrimary,
    },
    code_inline: {
      fontFamily: theme.typography.familyMono,
      backgroundColor: CODE_INLINE_BG[variant](theme),
      paddingHorizontal: theme.spacing.xs,
      paddingVertical: 1,
      borderRadius: theme.radii.xs,
      color: CODE_INLINE_TEXT[variant](theme),
      fontSize: theme.typography.sizes.caption,
    },
    fence: {
      backgroundColor: theme.colors.surfaceSunken,
      borderRadius: theme.radii.sm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.colors.separator,
      padding: theme.spacing.sm,
      marginVertical: theme.spacing.xs,
    },
    pre: {
      backgroundColor: theme.colors.surfaceSunken,
      borderRadius: theme.radii.sm,
      padding: theme.spacing.sm,
      fontFamily: theme.typography.familyMono,
      fontSize: theme.typography.sizes.caption,
      color: theme.colors.foregroundPrimary,
    },
    text: {
      fontFamily: theme.typography.familyMono,
      fontSize: theme.typography.sizes.caption,
      color: theme.colors.foregroundPrimary,
    },
    bullet_list: {
      marginVertical: theme.spacing.xs,
    },
    ordered_list: {
      marginVertical: theme.spacing.xs,
    },
    blockquote: {
      borderLeftColor: BLOCKQUOTE_COLORS[variant](theme),
      borderLeftWidth: 2,
      paddingLeft: theme.spacing.md,
      color: theme.colors.foregroundSecondary,
    },
    heading1: {
      color: headingColor,
      fontSize: theme.typography.sizes.titleLarge,
      fontWeight: theme.typography.weights.bold,
      marginVertical: theme.spacing.sm,
    },
    heading2: {
      color: headingColor,
      fontSize: theme.typography.sizes.titleMedium,
      fontWeight: theme.typography.weights.semibold,
      marginVertical: theme.spacing.sm,
    },
    heading3: {
      color: headingColor,
      fontSize: theme.typography.sizes.titleSmall,
      fontWeight: theme.typography.weights.semibold,
      marginVertical: theme.spacing.xs,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: theme.spacing.sm,
    },
  } as MarkdownStyle;
}
