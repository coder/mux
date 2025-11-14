import type { JSX } from "react";
import { useMemo, useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import {
  formatModelSummary,
  getModelDisplayName,
  isKnownModelId,
  listKnownModels,
} from "../utils/modelCatalog";

const ALL_MODELS = listKnownModels();

type KnownModel = (typeof ALL_MODELS)[number];

interface ModelPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedModel: string;
  onSelect: (modelId: string) => void;
  recentModels: string[];
}

export function ModelPickerSheet(props: ModelPickerSheetProps): JSX.Element {
  const theme = useTheme();
  const [query, setQuery] = useState("");

  const filteredModels = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return ALL_MODELS;
    }
    return ALL_MODELS.filter((model) => {
      const name = model.providerModelId.toLowerCase();
      const provider = model.provider.toLowerCase();
      return name.includes(normalized) || provider.includes(normalized);
    });
  }, [query]);

  const recentModels = useMemo(() => {
    return props.recentModels.filter(isKnownModelId);
  }, [props.recentModels]);

  const handleSelect = (modelId: string) => {
    props.onSelect(modelId);
  };

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View style={[styles.container, { backgroundColor: theme.colors.background }]}> 
        <View style={styles.header}>
          <ThemedText variant="titleMedium" weight="semibold">
            Choose a model
          </ThemedText>
          <Pressable onPress={props.onClose} style={styles.closeButton}>
            <Ionicons name="close" size={20} color={theme.colors.foregroundPrimary} />
          </Pressable>
        </View>

        <View
          style={[
            styles.searchWrapper,
            { borderColor: theme.colors.inputBorder, backgroundColor: theme.colors.inputBackground },
          ]}
        >
          <Ionicons name="search" size={16} color={theme.colors.foregroundMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search models"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.searchInput, { color: theme.colors.foregroundPrimary }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <Pressable onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={16} color={theme.colors.foregroundMuted} />
            </Pressable>
          )}
        </View>

        {recentModels.length > 0 && (
          <View style={styles.section}>
            <ThemedText variant="label" style={{ color: theme.colors.foregroundMuted }}>
              Recent
            </ThemedText>
            <View style={styles.recentChips}>
              {recentModels.map((modelId) => (
                <Pressable
                  key={modelId}
                  onPress={() => handleSelect(modelId)}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      backgroundColor:
                        props.selectedModel === modelId
                          ? theme.colors.accent
                          : theme.colors.surfaceSecondary,
                      opacity: pressed ? 0.8 : 1,
                    },
                  ]}
                >
                  <ThemedText
                    variant="caption"
                    style={{
                      color:
                        props.selectedModel === modelId
                          ? theme.colors.foregroundInverted
                          : theme.colors.foregroundPrimary,
                      fontWeight: "600",
                    }}
                  >
                    {getModelDisplayName(modelId)}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <FlatList
          data={filteredModels}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => handleSelect(item.id)}
              style={({ pressed }) => [
                styles.listItem,
                {
                  backgroundColor: pressed
                    ? theme.colors.surfaceSecondary
                    : theme.colors.background,
                },
              ]}
            >
              <View style={{ flex: 1 }}>
                <ThemedText weight="semibold">{getModelDisplayName(item.id)}</ThemedText>
                <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                  {formatModelSummary(item.id)}
                </ThemedText>
              </View>
              {props.selectedModel === item.id && (
                <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent} />
              )}
            </Pressable>
          )}
          ItemSeparatorComponent={() => (
            <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />
          )}
          ListEmptyComponent={() => (
            <View style={{ padding: 24 }}>
              <ThemedText variant="caption" style={{ textAlign: "center" }}>
                No models match "{query}"
              </ThemedText>
            </View>
          )}
          style={{ flex: 1 }}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  closeButton: {
    padding: 8,
  },
  searchWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
    marginBottom: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  section: {
    marginBottom: 12,
  },
  recentChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  listItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 4,
  },
});
