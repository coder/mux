import type { JSX } from "react";
import Slider from "@react-native-community/slider";
import { View } from "react-native";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import { useThinkingLevel, type ThinkingLevel } from "../contexts/ThinkingContext";

const LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

function thinkingLevelToValue(level: ThinkingLevel): number {
  const index = LEVELS.indexOf(level);
  return index >= 0 ? index : 0;
}

function valueToThinkingLevel(value: number): ThinkingLevel {
  const index = Math.round(value);
  return LEVELS[index] ?? "off";
}

export interface ReasoningControlProps {
  disabled?: boolean;
}

export function ReasoningControl({ disabled }: ReasoningControlProps): JSX.Element {
  const theme = useTheme();
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const sliderValue = thinkingLevelToValue(thinkingLevel);

  return (
    <View
      style={{
        padding: theme.spacing.sm,
        borderRadius: theme.radii.md,
        backgroundColor: theme.colors.surfaceSunken,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <ThemedText variant="label">Reasoning</ThemedText>
        <ThemedText variant="caption" weight="medium" style={{ textTransform: "uppercase" }}>
          {thinkingLevel}
        </ThemedText>
      </View>
      <Slider
        minimumValue={0}
        maximumValue={LEVELS.length - 1}
        step={1}
        value={sliderValue}
        onValueChange={(value) => setThinkingLevel(valueToThinkingLevel(value))}
        minimumTrackTintColor={theme.colors.accent}
        maximumTrackTintColor={theme.colors.border}
        thumbTintColor={theme.colors.accent}
        disabled={disabled}
        style={{ marginTop: theme.spacing.sm }}
      />
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          marginTop: theme.spacing.xs,
        }}
      >
        {LEVELS.map((level) => (
          <ThemedText key={level} variant="caption" style={{ textTransform: "uppercase" }}>
            {level}
          </ThemedText>
        ))}
      </View>
    </View>
  );
}
