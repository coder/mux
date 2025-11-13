import type { JSX } from "react";
import { useEffect, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { useTheme } from "../src/theme";
import { Surface } from "../src/components/Surface";
import { ThemedText } from "../src/components/ThemedText";

const STORAGE_KEY_BASE_URL = "com.coder.cmux.app-settings.baseUrl";
const STORAGE_KEY_AUTH_TOKEN = "com.coder.cmux.app-settings.authToken";

function getDefaultBaseUrl(): string {
  const extra = (Constants.expoConfig?.extra as any)?.cmux;
  return (extra?.baseUrl as string) ?? "http://localhost:3000";
}

export default function Settings(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const [baseUrl, setBaseUrl] = useState("");
  const [authToken, setAuthToken] = useState("");

  // Load settings from storage on mount
  useEffect(() => {
    async function loadSettings() {
      try {
        const storedBaseUrl = await SecureStore.getItemAsync(STORAGE_KEY_BASE_URL);
        const storedAuthToken = await SecureStore.getItemAsync(STORAGE_KEY_AUTH_TOKEN);

        // Use stored values if available, otherwise fall back to expo config
        const extra = (Constants.expoConfig?.extra as any)?.cmux;
        setBaseUrl(storedBaseUrl ?? extra?.baseUrl ?? getDefaultBaseUrl());
        setAuthToken(storedAuthToken ?? extra?.authToken ?? "");
      } catch (error) {
        console.error("Failed to load app settings:", error);
        // Fall back to expo config
        const extra = (Constants.expoConfig?.extra as any)?.cmux;
        setBaseUrl(extra?.baseUrl ?? getDefaultBaseUrl());
        setAuthToken(extra?.authToken ?? "");
      }
    }

    void loadSettings();
  }, []);

  // Save baseUrl immediately when changed
  const handleBaseUrlChange = async (value: string) => {
    setBaseUrl(value);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_BASE_URL, value);
    } catch (error) {
      console.error("Failed to save base URL:", error);
    }
  };

  // Save authToken immediately when changed
  const handleAuthTokenChange = async (value: string) => {
    setAuthToken(value);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY_AUTH_TOKEN, value);
    } catch (error) {
      console.error("Failed to save auth token:", error);
    }
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: spacing.lg }}
    >
      <Surface variant="plain" padding={spacing.lg}>
        <ThemedText variant="titleMedium" weight="bold">
          App Settings
        </ThemedText>
        <ThemedText variant="caption" style={{ marginTop: spacing.xs }}>
          Settings apply immediately. Server configuration requires app restart to take effect.
        </ThemedText>

        {/* Server Configuration Section */}
        <View style={{ marginTop: spacing.xl }}>
          <ThemedText variant="titleSmall" weight="semibold">
            Server Connection
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
              onChangeText={handleBaseUrlChange}
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
              onChangeText={handleAuthTokenChange}
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
      </Surface>
    </ScrollView>
  );
}
