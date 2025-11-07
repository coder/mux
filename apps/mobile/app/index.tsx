import type { JSX } from "react";
import { Stack, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import ProjectsScreen from "../src/screens/ProjectsScreen";

export default function ProjectsRoute(): JSX.Element {
  const router = useRouter();

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/settings")}
              style={{ paddingHorizontal: 12 }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="settings-outline" size={24} color="#fff" />
            </Pressable>
          ),
        }}
      />
      <ProjectsScreen />
    </>
  );
}
