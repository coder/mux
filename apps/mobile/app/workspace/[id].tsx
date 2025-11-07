import type { JSX } from "react";
import { useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import WorkspaceScreen from "../../src/screens/WorkspaceScreen";
import { WorkspaceActionSheet } from "../../src/components/WorkspaceActionSheet";
import {
  WorkspaceActionsProvider,
  useWorkspaceActions,
} from "../../src/contexts/WorkspaceActionsContext";

function WorkspaceContent(): JSX.Element {
  const params = useLocalSearchParams();
  const router = useRouter();
  const title = typeof params.title === "string" ? params.title : "";
  const id = typeof params.id === "string" ? params.id : "";

  const [showActionSheet, setShowActionSheet] = useState(false);
  const { toggleTodoCard, hasTodos } = useWorkspaceActions();

  const actionItems = [
    {
      id: "review",
      label: "Code Review",
      icon: "git-branch" as const,
      badge: undefined, // TODO: Add change count
      onPress: () => router.push(`/workspace/${id}/review`),
    },
    // Only show todo item if there are todos
    ...(hasTodos
      ? [
          {
            id: "todo",
            label: "Todo List",
            icon: "list-outline" as const,
            onPress: toggleTodoCard,
          },
        ]
      : []),
    {
      id: "settings",
      label: "Workspace Settings",
      icon: "settings-outline" as const,
      onPress: () => router.push("/workspace-settings"),
    },
  ];

  return (
    <>
      <Stack.Screen
        options={{
          title,
          headerRight: () => (
            <Pressable
              onPress={() => setShowActionSheet(true)}
              style={{ paddingHorizontal: 12 }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="ellipsis-horizontal-circle" size={24} color="#fff" />
            </Pressable>
          ),
        }}
      />
      <WorkspaceScreen />
      <WorkspaceActionSheet
        visible={showActionSheet}
        onClose={() => setShowActionSheet(false)}
        items={actionItems}
      />
    </>
  );
}

export default function WorkspaceRoute(): JSX.Element {
  return (
    <WorkspaceActionsProvider>
      <WorkspaceContent />
    </WorkspaceActionsProvider>
  );
}
