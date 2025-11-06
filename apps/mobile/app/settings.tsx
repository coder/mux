import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, TextInput, View } from "react-native";
import Constants from "expo-constants";
import Slider from "@react-native-community/slider";
import { useTheme } from "../src/theme";
import { Surface } from "../src/components/Surface";
import { ThemedText } from "../src/components/ThemedText";
import { useWorkspaceDefaults, type WorkspaceMode } from "../src/hooks/useWorkspaceDefaults";
import type { ThinkingLevel } from "../src/contexts/ThinkingContext";

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

function getDefaultBaseUrl(): string {
  const extra = (Constants.expoConfig?.extra as any)?.cmux;
  return (extra?.baseUrl as string) ?? "http://localhost:3000";
}

export default function Settings(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");
  
  const {
    defaultMode,
    defaultReasoningLevel,
    setDefaultMode,
    setDefaultReasoningLevel,
    isLoading: defaultsLoading,
  } = useWorkspaceDefaults();

  useEffect(() => {
    const extra = (Constants.expoConfig?.extra as any)?.cmux;
    setBaseUrl(extra?.baseUrl ?? getDefaultBaseUrl());
    setAuthToken(extra?.authToken ?? "");
  }, []);

  const onSave = () => {
    Alert.alert(
      "Settings saved",
      "Server configuration requires app restart. Workspace defaults are applied immediately."
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: spacing.lg }}
    >
      <Surface variant="plain" padding={spacing.lg}>
        <ThemedText variant="titleMedium" weight="bold">
          Settings
        </ThemedText>
        <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
          Configure your mobile app preferences and server connection.
        </ThemedText>

        {/* Server Configuration Section */}
        <View style={{ marginTop: spacing.xl }}>
          <ThemedText variant="titleSmall" weight="semibold">
            Server Configuration
          </ThemedText>
          <View
            style={{
              marginTop: spacing.sm,
              height: 1,
              backgroundColor: theme.colors.border,
            }}
          />
        </View>

        <View style={{ marginTop: spacing.md, gap: spacing.md }}>
          <View>
            <ThemedText variant="label">Base URL</ThemedText>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="http://<tailscale-ip>:3000"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={{
                marginTop: spacing.xs,
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: theme.radii.sm,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                backgroundColor: theme.colors.inputBackground,
                color: theme.colors.foregroundPrimary,
              }}
            />
          </View>

          <View>
            <ThemedText variant="label">Auth Token (optional)</ThemedText>
            <TextInput
              value={authToken}
              onChangeText={setAuthToken}
              placeholder="token"
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={{
                marginTop: spacing.xs,
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: theme.radii.sm,
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.md,
                backgroundColor: theme.colors.inputBackground,
                color: theme.colors.foregroundPrimary,
              }}
            />
          </View>

          <ThemedText
            variant="caption"
            style={{ marginTop: spacing.xs, color: theme.colors.foregroundMuted }}
          >
            Tip: Set CMUX_SERVER_AUTH_TOKEN on the server and pass the token here. The app forwards
            it as a query parameter on WebSocket connections.
          </ThemedText>
        </View>

        {/* Workspace Defaults Section */}
        <View style={{ marginTop: spacing.xl }}>
          <ThemedText variant="titleSmall" weight="semibold">
            Workspace Defaults
          </ThemedText>
          <View
            style={{
              marginTop: spacing.sm,
              height: 1,
              backgroundColor: theme.colors.border,
            }}
          />
        </View>

        <View style={{ marginTop: spacing.md, gap: spacing.lg }}>
          {/* Execution Mode */}
          <View>
            <ThemedText variant="label" style={{ marginBottom: spacing.sm }}>
              Default Execution Mode
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
          <View>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: spacing.sm,
              }}
            >
              <ThemedText variant="label">Default Reasoning Level</ThemedText>
              <ThemedText
                variant="caption"
                weight="medium"
                style={{ textTransform: "uppercase" }}
              >
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
                onValueChange={(value) =>
                  setDefaultReasoningLevel(valueToThinkingLevel(value))
                }
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
        </View>

        <Pressable
          onPress={onSave}
          style={({ pressed }) => ({
            marginTop: spacing.xl,
            alignSelf: "flex-start",
            paddingVertical: spacing.sm,
            paddingHorizontal: spacing.lg,
            borderRadius: theme.radii.sm,
            backgroundColor: pressed ? theme.colors.accentHover : theme.colors.accent,
          })}
        >
          <ThemedText style={{ color: theme.colors.foregroundInverted }} weight="semibold">
            Save
          </ThemedText>
        </Pressable>
      </Surface>
    </ScrollView>
  );
}
