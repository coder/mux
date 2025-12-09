import type { JSX } from "react";
import type { ViewProps, ViewStyle } from "react-native";
import { View } from "react-native";
import { useMemo } from "react";
import { useTheme } from "../theme";
import { assert } from "../utils/assert";

export type SurfaceVariant = "plain" | "raised" | "sunken" | "ghost";

export interface SurfaceProps extends ViewProps {
  variant?: SurfaceVariant;
  padding?: number;
}

export function Surface({
  variant = "plain",
  style,
  padding,
  children,
  ...rest
}: SurfaceProps): JSX.Element {
  const theme = useTheme();

  const variantStyle = useMemo(() => {
    const mapper: Record<SurfaceVariant, ViewStyle> = {
      plain: {
        backgroundColor: theme.colors.surface,
        borderColor: theme.colors.border,
        borderWidth: 1,
      },
      raised: {
        backgroundColor: theme.colors.surfaceElevated,
        borderColor: theme.colors.border,
        borderWidth: 1,
        ...theme.shadows.subtle,
      },
      sunken: {
        backgroundColor: theme.colors.surfaceSunken,
        borderColor: theme.colors.borderSubtle,
        borderWidth: 1,
      },
      ghost: {
        backgroundColor: "transparent",
        borderWidth: 0,
      },
    };

    const mapped = mapper[variant];
    assert(mapped, `Unsupported surface variant: ${variant}`);
    return mapped;
  }, [theme, variant]);

  return (
    <View
      style={[
        {
          borderRadius: theme.radii.md,
          padding,
        },
        variantStyle,
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}
