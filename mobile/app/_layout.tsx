import type { JSX } from "react";
import { Stack } from "expo-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { ThemeProvider, useTheme } from "../src/theme";
import { WorkspaceChatProvider } from "../src/contexts/WorkspaceChatContext";
import { AppConfigProvider } from "../src/contexts/AppConfigContext";

function AppFrame(): JSX.Element {
  const theme = useTheme();

  return (
    <>
      <StatusBar style={theme.statusBarStyle} animated />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.colors.surfaceSunken },
            headerTintColor: theme.colors.foregroundPrimary,
            headerTitleStyle: {
              fontWeight: theme.typography.weights.semibold as any,
              fontSize: theme.typography.sizes.titleSmall,
              color: theme.colors.foregroundPrimary,
            },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.colors.background },
          }}
        >
          <Stack.Screen
            name="index"
            options={{
              title: "Workspaces",
            }}
          />
          <Stack.Screen
            name="workspace/[id]"
            options={{
              title: "", // Title set dynamically by WorkspaceScreen
              headerBackTitle: "", // Just show <, no text
            }}
          />
          <Stack.Screen
            name="settings"
            options={{
              title: "Settings",
              headerBackTitle: "", // Just show <, no text
            }}
          />
        </Stack>
      </View>
    </>
  );
}

export default function RootLayout(): JSX.Element {
  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
    []
  );

  return (
    <QueryClientProvider client={client}>
      <SafeAreaProvider>
        <ThemeProvider>
          <AppConfigProvider>
            <WorkspaceChatProvider>
              <AppFrame />
            </WorkspaceChatProvider>
          </AppConfigProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
