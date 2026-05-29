import { useEffect, useRef } from "react";
import { Animated, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";

export type ToastTone = "info" | "success" | "error";

export interface ToastPayload {
  title: string;
  message: string;
  tone: ToastTone;
}

export interface ToastState extends ToastPayload {
  id: string;
}

interface ToastBannerProps {
  toast: ToastState;
  onDismiss: () => void;
}

export function ToastBanner(props: ToastBannerProps) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [opacity, props.toast.id]);

  const palette = getPalette(props.toast.tone, theme.colors);

  return (
    <Animated.View
      accessibilityRole="alert"
      style={{
        opacity,
        transform: [
          {
            translateY: opacity.interpolate({
              inputRange: [0, 1],
              outputRange: [-12, 0],
            }),
          },
        ],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        shadowColor: "#000",
        shadowOpacity: 0.3,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: theme.spacing.sm,
        }}
      >
        <Ionicons
          name={palette.icon}
          size={18}
          color={palette.iconColor}
          style={{ marginTop: 1 }}
        />
        <View style={{ flex: 1, gap: 2 }}>
          <ThemedText weight="semibold" style={{ color: palette.text }}>
            {props.toast.title}
          </ThemedText>
          <ThemedText variant="caption" style={{ color: palette.text }}>
            {props.toast.message}
          </ThemedText>
        </View>
        <Pressable
          accessibilityLabel="Dismiss notification"
          onPress={props.onDismiss}
          style={({ pressed }) => ({
            padding: theme.spacing.xs,
            marginLeft: theme.spacing.xs,
            borderRadius: theme.radii.sm,
            backgroundColor: pressed ? palette.dismissBackground : "transparent",
          })}
        >
          <Ionicons name="close" size={16} color={palette.iconColor} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function getPalette(tone: ToastTone, colors: ReturnType<typeof useTheme>["colors"]) {
  switch (tone) {
    case "success":
      return {
        background: colors.successBackground,
        border: colors.success,
        text: colors.foregroundPrimary,
        icon: "checkmark-circle-outline" as const,
        iconColor: colors.success,
        dismissBackground: "rgba(76, 175, 80, 0.12)",
      };
    case "error":
      return {
        background: colors.errorBackground,
        border: colors.error,
        text: colors.foregroundPrimary,
        icon: "warning-outline" as const,
        iconColor: colors.error,
        dismissBackground: "rgba(244, 67, 54, 0.12)",
      };
    case "info":
    default:
      return {
        background: colors.surfaceSecondary,
        border: colors.accent,
        text: colors.foregroundPrimary,
        icon: "information-circle-outline" as const,
        iconColor: colors.accent,
        dismissBackground: "rgba(0, 122, 204, 0.12)",
      };
  }
}
