import type { JSX } from "react";
import { useEffect, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { useTheme } from "../src/theme";
import { Surface } from "../src/components/Surface";
import { ThemedText } from "../src/components/ThemedText";

function getDefaultBaseUrl(): string {
  const extra = (Constants.expoConfig?.extra as any)?.cmux;
  return (extra?.baseUrl as string) ?? "http://localhost:3000";
}

export default function Settings(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");

  useEffect(() => {
    const extra = (Constants.expoConfig?.extra as any)?.cmux;
    setBaseUrl(extra?.baseUrl ?? getDefaultBaseUrl());
    setAuthToken(extra?.authToken ?? "");
  }, []);

  const onSave = () => {
    Alert.alert(
      "Configuration saved",
      "Update apps/mobile/app.json to persist across reloads."
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: spacing.lg }}>
      <Surface variant="plain" padding={spacing.lg}>
        <ThemedText variant="titleMedium" weight="bold">
          Settings
        </ThemedText>
        <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
          Configure how the mobile app connects to your cmux server instance.
        </ThemedText>

        <View style={{ marginTop: spacing.lg, gap: spacing.md }}>
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
        </View>

        <Pressable
          onPress={onSave}
          style={({ pressed }) => ({
            marginTop: spacing.lg,
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

        <ThemedText variant="caption" style={{ marginTop: spacing.lg, color: theme.colors.foregroundMuted }}>
          Tip: Set CMUX_SERVER_AUTH_TOKEN on the server and pass the token here. The app forwards it as a
          query parameter on WebSocket connections.
        </ThemedText>
      </Surface>
    </View>
  );
}
