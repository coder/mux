import type { JSX } from "react";
import { useEffect } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Stack } from "expo-router";
import Slider from "@react-native-community/slider";
import { Picker } from "@react-native-picker/picker";
import { useTheme } from "../src/theme";
import { Surface } from "../src/components/Surface";
import { ThemedText } from "../src/components/ThemedText";
import { useWorkspaceDefaults } from "../src/hooks/useWorkspaceDefaults";
import type { ThinkingLevel, WorkspaceMode } from "../src/types/settings";
import { supports1MContext } from "@/common/utils/ai/models";
import { KNOWN_MODEL_OPTIONS } from "@/common/constants/knownModels";

const MODE_TABS: WorkspaceMode[] = ["plan", "exec"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

function thinkingLevelToValue(level: ThinkingLevel): number {
  const index = THINKING_LEVELS.indexOf(level);
  return index >= 0 ? index : 0;
}

function valueToThinkingLevel(value: number): ThinkingLevel {
  const index = Math.round(value);
  return THINKING_LEVELS[index] ?? "off";
}

export default function WorkspaceSettings(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;

  const {
    defaultMode,
    defaultReasoningLevel,
    defaultModel,
    use1MContext,
    setDefaultMode,
    setDefaultReasoningLevel,
    setDefaultModel,
    setUse1MContext,
    isLoading: defaultsLoading,
  } = useWorkspaceDefaults();

  const modelSupports1M = supports1MContext(defaultModel);

  // Auto-disable 1M context if model doesn't support it
  useEffect(() => {
    if (!modelSupports1M && use1MContext) {
      void setUse1MContext(false);
    }
  }, [modelSupports1M, use1MContext, setUse1MContext]);

  return (
    <>
      <Stack.Screen options={{ title: "Workspace Defaults", headerBackTitle: "" }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: theme.colors.background }}
        contentContainerStyle={{ padding: spacing.lg }}
      >
        <Surface variant="plain" padding={spacing.lg}>
          <ThemedText variant="titleMedium" weight="bold">
            Default Settings
          </ThemedText>
          <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
            Set default preferences for new workspaces. Change settings per workspace via the ⋯
            menu.
          </ThemedText>

          {/* Model Selection */}
          <View style={{ marginTop: spacing.xl }}>
            <ThemedText variant="titleSmall" weight="semibold">
              Model
            </ThemedText>
            <View
              style={{
                marginTop: spacing.sm,
                height: 1,
                backgroundColor: theme.colors.border,
              }}
            />
          </View>

          <View style={{ marginTop: spacing.md }}>
            <ThemedText variant="label" style={{ marginBottom: spacing.sm }}>
              Default Model
            </ThemedText>
            <View
              style={{
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: theme.radii.sm,
                backgroundColor: theme.colors.inputBackground,
                overflow: "hidden",
              }}
            >
              <Picker
                selectedValue={defaultModel}
                onValueChange={(value) => void setDefaultModel(value)}
                style={{
                  color: theme.colors.foregroundPrimary,
                }}
                dropdownIconColor={theme.colors.foregroundPrimary}
              >
                {KNOWN_MODEL_OPTIONS.map((model) => (
                  <Picker.Item
                    key={model.value}
                    label={model.label}
                    value={model.value}
                    color={theme.colors.foregroundPrimary}
                  />
                ))}
              </Picker>
            </View>
          </View>

          {/* 1M Context Toggle */}
          {modelSupports1M && (
            <View style={{ marginTop: spacing.md }}>
              <Pressable
                onPress={() => void setUse1MContext(!use1MContext)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingVertical: spacing.sm,
                }}
              >
                <View style={{ flex: 1 }}>
                  <ThemedText variant="label">Use 1M Context</ThemedText>
                  <ThemedText
                    variant="caption"
                    style={{ marginTop: spacing.xs, color: theme.colors.foregroundMuted }}
                  >
                    Enable extended context window (only for Sonnet 4+)
                  </ThemedText>
                </View>
                <View
                  style={{
                    width: 50,
                    height: 30,
                    borderRadius: 15,
                    backgroundColor: use1MContext ? theme.colors.accent : theme.colors.border,
                    padding: 2,
                    justifyContent: "center",
                  }}
                >
                  <View
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 13,
                      backgroundColor: theme.colors.foregroundInverted,
                      transform: [{ translateX: use1MContext ? 20 : 0 }],
                    }}
                  />
                </View>
              </Pressable>
            </View>
          )}

          {/* Execution Mode */}
          <View style={{ marginTop: spacing.xl }}>
            <ThemedText variant="titleSmall" weight="semibold">
              Execution Mode
            </ThemedText>
            <View
              style={{
                marginTop: spacing.sm,
                height: 1,
                backgroundColor: theme.colors.border,
              }}
            />
          </View>

          <View style={{ marginTop: spacing.md }}>
            <ThemedText variant="label" style={{ marginBottom: spacing.sm }}>
              Default Mode
            </ThemedText>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: theme.colors.surfaceSunken,
                padding: spacing.xs,
                borderRadius: theme.radii.pill,
              }}
            >
              {MODE_TABS.map((tab) => {
                const selected = tab === defaultMode;
                return (
                  <Pressable
                    key={tab}
                    onPress={() => setDefaultMode(tab)}
                    disabled={defaultsLoading}
                    style={({ pressed }) => ({
                      flex: 1,
                      paddingVertical: spacing.sm,
                      borderRadius: theme.radii.pill,
                      backgroundColor: selected
                        ? theme.colors.accent
                        : pressed
                          ? theme.colors.accentMuted
                          : "transparent",
                    })}
                  >
                    <ThemedText
                      align="center"
                      weight={selected ? "semibold" : "regular"}
                      style={{
                        color: selected
                          ? theme.colors.foregroundInverted
                          : theme.colors.foregroundSecondary,
                      }}
                    >
                      {tab.toUpperCase()}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
            <ThemedText
              variant="caption"
              style={{ marginTop: spacing.xs, color: theme.colors.foregroundMuted }}
            >
              Plan mode: AI proposes changes. Exec mode: AI makes changes directly.
            </ThemedText>
          </View>

          {/* Reasoning Level */}
          <View style={{ marginTop: spacing.xl }}>
            <ThemedText variant="titleSmall" weight="semibold">
              Reasoning
            </ThemedText>
            <View
              style={{
                marginTop: spacing.sm,
                height: 1,
                backgroundColor: theme.colors.border,
              }}
            />
          </View>

          <View style={{ marginTop: spacing.md }}>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: spacing.sm,
              }}
            >
              <ThemedText variant="label">Default Reasoning Level</ThemedText>
              <ThemedText variant="caption" weight="medium" style={{ textTransform: "uppercase" }}>
                {defaultReasoningLevel}
              </ThemedText>
            </View>
            <View
              style={{
                padding: spacing.sm,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surfaceSunken,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <Slider
                minimumValue={0}
                maximumValue={THINKING_LEVELS.length - 1}
                step={1}
                value={thinkingLevelToValue(defaultReasoningLevel)}
                onValueChange={(value) => setDefaultReasoningLevel(valueToThinkingLevel(value))}
                minimumTrackTintColor={theme.colors.accent}
                maximumTrackTintColor={theme.colors.border}
                thumbTintColor={theme.colors.accent}
                disabled={defaultsLoading}
                style={{ marginTop: spacing.xs }}
              />
              <View
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  marginTop: spacing.xs,
                }}
              >
                {THINKING_LEVELS.map((level) => (
                  <ThemedText
                    key={level}
                    variant="caption"
                    style={{ textTransform: "uppercase", fontSize: 9 }}
                  >
                    {level}
                  </ThemedText>
                ))}
              </View>
            </View>
            <ThemedText
              variant="caption"
              style={{ marginTop: spacing.xs, color: theme.colors.foregroundMuted }}
            >
              Higher reasoning levels use extended thinking for complex tasks.
            </ThemedText>
          </View>
        </Surface>
      </ScrollView>
    </>
  );
}
