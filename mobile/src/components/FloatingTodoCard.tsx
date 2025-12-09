import type { JSX } from "react";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "./ThemedText";
import { TodoItemView, type TodoItem } from "./TodoItemView";
import { useTheme } from "../theme";

interface FloatingTodoCardProps {
  todos: TodoItem[];
}

/**
 * Floating todo card that appears above the input area during streaming.
 * Shows current progress and updates in real-time as agent works.
 * Disappears when stream ends.
 */
export function FloatingTodoCard({ todos }: FloatingTodoCardProps): JSX.Element | null {
  const theme = useTheme();
  const spacing = theme.spacing;
  const [isExpanded, setIsExpanded] = useState(true);

  if (todos.length === 0) {
    return null;
  }

  const completedCount = todos.filter((t) => t.status === "completed").length;

  return (
    <View
      style={{
        backgroundColor: theme.colors.surfaceSecondary,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        maxHeight: 200,
      }}
    >
      {/* Header */}
      <Pressable
        onPress={() => setIsExpanded(!isExpanded)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingVertical: spacing.sm,
          paddingHorizontal: spacing.md,
          backgroundColor: theme.colors.surfaceSecondary,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text style={{ fontSize: 18 }}>📋</Text>
          <ThemedText variant="label" weight="semibold">
            TODO ({completedCount}/{todos.length})
          </ThemedText>
          <Ionicons
            name={isExpanded ? "chevron-down" : "chevron-forward"}
            size={16}
            color={theme.colors.foregroundSecondary}
          />
        </View>
      </Pressable>

      {/* Todo Items */}
      {isExpanded && (
        <ScrollView
          style={{ maxHeight: 150 }}
          contentContainerStyle={{
            paddingHorizontal: spacing.md,
            paddingBottom: spacing.sm,
          }}
          showsVerticalScrollIndicator
        >
          {todos.map((todo, index) => (
            <TodoItemView key={index} todo={todo} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
