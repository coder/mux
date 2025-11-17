import type { JSX } from "react";
import { ScrollView, TextInput, View } from "react-native";
import { useTheme } from "../src/theme";
import { Surface } from "../src/components/Surface";
import { ThemedText } from "../src/components/ThemedText";
import { useAppConfig } from "../src/contexts/AppConfigContext";

export default function Settings(): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const { baseUrl, authToken, setBaseUrl, setAuthToken } = useAppConfig();

  const handleBaseUrlChange = (value: string) => {
    void setBaseUrl(value);
  };

  const handleAuthTokenChange = (value: string) => {
    void setAuthToken(value);
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
              value={authToken ?? ""}
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
            Tip: Set MUX_SERVER_AUTH_TOKEN on the server and pass the token here. The app forwards
            it as a query parameter on WebSocket connections.
          </ThemedText>
        </View>
      </Surface>
    </ScrollView>
  );
}
