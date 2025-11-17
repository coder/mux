import { FlatList, Pressable, View, type ListRenderItemInfo } from "react-native";
import type { SlashSuggestion } from "@/browser/utils/slashCommands/types";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";

interface SlashCommandSuggestionsProps {
  suggestions: SlashSuggestion[];
  visible: boolean;
  highlightedIndex: number;
  listId: string;
  onSelect: (suggestion: SlashSuggestion) => void;
  onHighlight: (index: number) => void;
}

export function SlashCommandSuggestions(props: SlashCommandSuggestionsProps) {
  const theme = useTheme();

  if (!props.visible || props.suggestions.length === 0) {
    return null;
  }

  return (
    <View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "100%",
        marginBottom: theme.spacing.xs,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
        shadowColor: "#000",
        shadowOpacity: 0.2,
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 12,
        elevation: 4,
        zIndex: 20,
      }}
    >
      <FlatList<SlashSuggestion>
        data={props.suggestions}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item, index }: ListRenderItemInfo<SlashSuggestion>) => {
          const highlighted = index === props.highlightedIndex;
          return (
            <Pressable
              onPress={() => props.onSelect(item)}
              onHoverIn={() => props.onHighlight(index)}
              onPressIn={() => props.onHighlight(index)}
              style={({ pressed }) => ({
                paddingVertical: theme.spacing.sm,
                paddingHorizontal: theme.spacing.md,
                backgroundColor: highlighted
                  ? theme.colors.surfaceSecondary
                  : pressed
                    ? theme.colors.surfaceSecondary
                    : theme.colors.surface,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.spacing.md,
              })}
            >
              <ThemedText weight="semibold" style={{ color: theme.colors.accent }}>
                {item.display}
              </ThemedText>
              <ThemedText
                numberOfLines={1}
                style={{ flex: 1, color: theme.colors.foregroundMuted, textAlign: "right" }}
              >
                {item.description}
              </ThemedText>
            </Pressable>
          );
        }}
        style={{ maxHeight: 240 }}
      />
    </View>
  );
}
