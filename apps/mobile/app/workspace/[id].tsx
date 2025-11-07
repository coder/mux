import type { JSX } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import WorkspaceScreen from "../../src/screens/WorkspaceScreen";

export default function WorkspaceRoute(): JSX.Element {
  const params = useLocalSearchParams();
  const router = useRouter();
  const title = typeof params.title === "string" ? params.title : "";
  const id = typeof params.id === "string" ? params.id : "";

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <Pressable
              onPress={() => router.push(`/workspace/${id}/review`)}
              style={{ paddingHorizontal: 12 }}
            >
              <Ionicons name="git-branch" size={22} color="#fff" />
            </Pressable>
          ),
        }}
      />
      <WorkspaceScreen />
    </>
  );
}
