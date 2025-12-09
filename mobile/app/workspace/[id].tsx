import type { JSX } from "react";
import { useState } from "react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import WorkspaceScreen from "../../src/screens/WorkspaceScreen";
import { WorkspaceActionSheet } from "../../src/components/WorkspaceActionSheet";
import { CostUsageSheet } from "../../src/components/CostUsageSheet";
import { WorkspaceCostProvider } from "../../src/contexts/WorkspaceCostContext";

function WorkspaceContent(): JSX.Element {
  const params = useLocalSearchParams();
  const router = useRouter();
  const title = typeof params.title === "string" ? params.title : "";
  const id = typeof params.id === "string" ? params.id : "";

  // Check for creation mode
  const isCreationMode = id === "new";
  const projectPath = typeof params.projectPath === "string" ? params.projectPath : undefined;
  const projectName = typeof params.projectName === "string" ? params.projectName : undefined;

  const [showActionSheet, setShowActionSheet] = useState(false);
  const [showCostSheet, setShowCostSheet] = useState(false);

  // Handle creation mode
  if (isCreationMode && projectPath && projectName) {
    return (
      <WorkspaceCostProvider workspaceId={null}>
        <>
          <Stack.Screen
            options={{
              title: `New Chat - ${projectName}`,
              headerBackVisible: true,
            }}
          />
          <WorkspaceScreen creationContext={{ projectPath, projectName }} />
        </>
      </WorkspaceCostProvider>
    );
  }

  const actionItems = [
    {
      id: "cost",
      label: "Cost & Usage",
      icon: "analytics-outline" as const,
      onPress: () => {
        setShowActionSheet(false);
        setShowCostSheet(true);
      },
    },
    {
      id: "review",
      label: "Code Review",
      icon: "git-branch" as const,
      badge: undefined, // TODO: Add change count
      onPress: () => router.push(`/workspace/${id}/review`),
    },
  ];

  if (!id) {
    return <></>;
  }

  return (
    <WorkspaceCostProvider workspaceId={id}>
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
        <CostUsageSheet visible={showCostSheet} onClose={() => setShowCostSheet(false)} />
      </>
    </WorkspaceCostProvider>
  );
}

export default function WorkspaceRoute(): JSX.Element {
  return <WorkspaceContent />;
}
