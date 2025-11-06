import type { JSX } from "react";
import { Stack, useLocalSearchParams } from "expo-router";
import WorkspaceScreen from "../../src/screens/WorkspaceScreen";

export default function WorkspaceRoute(): JSX.Element {
  const params = useLocalSearchParams();
  const title = typeof params.title === "string" ? params.title : "";

  return (
    <>
      <Stack.Screen options={{ title }} />
      <WorkspaceScreen />
    </>
  );
}
