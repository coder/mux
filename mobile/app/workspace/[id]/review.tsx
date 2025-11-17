import type { JSX } from "react";
import { Stack } from "expo-router";
import GitReviewScreen from "src/screens/GitReviewScreen";

export default function GitReviewRoute(): JSX.Element {
  return (
    <>
      <Stack.Screen
        options={{
          title: "Code Review",
          headerBackTitle: "",
        }}
      />
      <GitReviewScreen />
    </>
  );
}
