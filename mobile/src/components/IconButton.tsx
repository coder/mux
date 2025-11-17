import type { JSX } from "react";
import type { PressableProps, ViewStyle } from "react-native";
import { Pressable } from "react-native";
import type { ReactNode } from "react";
import { useTheme } from "../theme";
import { assert } from "../utils/assert";

export type IconButtonVariant = "ghost" | "primary" | "danger";
export type IconButtonSize = "sm" | "md";

export interface IconButtonProps extends Omit<PressableProps, "style"> {
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
}

const SIZE_MAP: Record<IconButtonSize, number> = {
  sm: 36,
  md: 44,
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "md",
  ...rest
}: IconButtonProps): JSX.Element {
  const theme = useTheme();

  const resolveVariantStyle = (): ViewStyle => {
    const variantStyles: Record<IconButtonVariant, ViewStyle> = {
      ghost: {
        backgroundColor: theme.colors.accentMuted,
        borderColor: theme.colors.accent,
        borderWidth: 0,
      },
      primary: {
        backgroundColor: theme.colors.accent,
        borderColor: theme.colors.accentHover,
        borderWidth: 1,
      },
      danger: {
        backgroundColor: theme.colors.danger,
        borderColor: theme.colors.danger,
        borderWidth: 1,
      },
    };
    const style = variantStyles[variant];
    assert(style, `Unsupported IconButton variant: ${variant}`);
    return style;
  };

  const dimension = SIZE_MAP[size];
  assert(dimension !== undefined, `Unsupported IconButton size: ${size}`);

  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [
        {
          alignItems: "center",
          justifyContent: "center",
          borderRadius: theme.radii.pill,
          width: dimension,
          height: dimension,
          opacity: pressed ? 0.75 : 1,
        },
        resolveVariantStyle(),
      ]}
      hitSlop={8}
      {...rest}
    >
      {icon}
    </Pressable>
  );
}
