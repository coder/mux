import type { JSX } from "react";
import { useMemo, useState, useEffect } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import type { ThinkingLevel, WorkspaceMode } from "../types/settings";
import {
  formatModelSummary,
  getModelDisplayName,
  isKnownModelId,
  listKnownModels,
} from "../utils/modelCatalog";

const ALL_MODELS = listKnownModels();
const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high"];

interface RunSettingsSheetProps {
  visible: boolean;
  onClose: () => void;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  recentModels: string[];
  mode: WorkspaceMode;
  onSelectMode: (mode: WorkspaceMode) => void;
  thinkingLevel: ThinkingLevel;
  onSelectThinkingLevel: (level: ThinkingLevel) => void;
  use1MContext: boolean;
  onToggle1MContext: (enabled: boolean) => void;
  supportsExtendedContext: boolean;
}

export function RunSettingsSheet(props: RunSettingsSheetProps): JSX.Element {
  const theme = useTheme();
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!props.visible) {
      setQuery("");
    }
  }, [props.visible]);

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

  const handleSelectModel = (modelId: string) => {
    props.onSelectModel(modelId);
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
          <ThemedText variant="titleMedium" weight="semibold" style={styles.headerTitle}>
            Settings
          </ThemedText>
          <Pressable onPress={props.onClose} style={styles.closeButton}>
            <Ionicons name="close" size={20} color={theme.colors.foregroundPrimary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <View style={[styles.sectionBlock, { borderColor: theme.colors.border }]}>
            <View style={styles.sectionHeading}>
              <ThemedText variant="label" weight="semibold">
                Model
              </ThemedText>
              <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                {formatModelSummary(props.selectedModel)}
              </ThemedText>
            </View>

            <View
              style={[
                styles.searchWrapper,
                {
                  borderColor: theme.colors.inputBorder,
                  backgroundColor: theme.colors.inputBackground,
                },
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
                      onPress={() => handleSelectModel(modelId)}
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

            <View style={styles.modelList}>
              {filteredModels.length === 0 ? (
                <View style={{ padding: 24 }}>
                  <ThemedText variant="caption" style={{ textAlign: "center" }}>
                    No models match "{query}"
                  </ThemedText>
                </View>
              ) : (
                filteredModels.map((item, index) => (
                  <View key={item.id}>
                    <Pressable
                      onPress={() => handleSelectModel(item.id)}
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
                        <ThemedText
                          variant="caption"
                          style={{ color: theme.colors.foregroundMuted }}
                        >
                          {formatModelSummary(item.id)}
                        </ThemedText>
                      </View>
                      {props.selectedModel === item.id && (
                        <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent} />
                      )}
                    </Pressable>
                    {index < filteredModels.length - 1 ? (
                      <View
                        style={{
                          height: StyleSheet.hairlineWidth,
                          backgroundColor: theme.colors.border,
                        }}
                      />
                    ) : null}
                  </View>
                ))
              )}
            </View>
            {props.supportsExtendedContext ? (
              <View
                style={{
                  marginTop: 20,
                  paddingTop: 12,
                  borderTopWidth: StyleSheet.hairlineWidth,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderTopColor: theme.colors.border,
                  borderBottomColor: theme.colors.border,
                  paddingBottom: 12,
                  gap: 8,
                }}
              >
                <View style={styles.sectionHeading}>
                  <ThemedText weight="semibold">Context window</ThemedText>
                  <Ionicons
                    name="information-circle-outline"
                    size={16}
                    color={theme.colors.foregroundMuted}
                  />
                </View>
                <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                  Use the 1M-token Anthropic context window when supported.
                </ThemedText>
                <View style={styles.toggleRow}>
                  <ThemedText weight="semibold">1M token context</ThemedText>
                  <Switch
                    trackColor={{ false: theme.colors.inputBorder, true: theme.colors.accent }}
                    thumbColor={props.use1MContext ? theme.colors.accent : theme.colors.surface}
                    value={props.use1MContext}
                    onValueChange={props.onToggle1MContext}
                    disabled={!props.selectedModel?.startsWith("anthropic")}
                  />
                </View>
              </View>
            ) : null}
          </View>

          <View style={[styles.sectionBlock, { borderColor: theme.colors.border }]}>
            <ThemedText variant="label" weight="semibold" style={styles.sectionTitle}>
              Mode
            </ThemedText>
            <View style={styles.modeRow}>
              {(["plan", "exec"] as WorkspaceMode[]).map((modeOption) => (
                <Pressable
                  key={modeOption}
                  onPress={() => props.onSelectMode(modeOption)}
                  style={({ pressed }) => {
                    const isSelected = props.mode === modeOption;
                    const selectedFill =
                      modeOption === "plan" ? theme.colors.planMode : theme.colors.execMode;
                    return [
                      styles.modeCard,
                      {
                        borderColor: isSelected ? selectedFill : theme.colors.border,
                        backgroundColor: isSelected ? selectedFill : theme.colors.surfaceSecondary,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ];
                  }}
                >
                  <ThemedText
                    weight="semibold"
                    style={{
                      textTransform: "capitalize",
                      color:
                        props.mode === modeOption
                          ? theme.colors.foregroundInverted
                          : theme.colors.foregroundPrimary,
                    }}
                  >
                    {modeOption}
                  </ThemedText>
                  <ThemedText
                    variant="caption"
                    style={{
                      color:
                        props.mode === modeOption
                          ? theme.colors.foregroundInverted
                          : theme.colors.foregroundMuted,
                    }}
                  >
                    {modeOption === "plan" ? "Plan before executing" : "Act directly"}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </View>

          <View style={[styles.sectionBlock, { borderColor: theme.colors.border }]}>
            <ThemedText variant="label" weight="semibold" style={styles.sectionTitle}>
              Reasoning
            </ThemedText>
            <View style={styles.levelRow}>
              {THINKING_LEVELS.map((level) => {
                const active = props.thinkingLevel === level;
                return (
                  <Pressable
                    key={level}
                    onPress={() => props.onSelectThinkingLevel(level)}
                    style={({ pressed }) => [
                      styles.levelChip,
                      {
                        backgroundColor: active
                          ? theme.colors.accent
                          : theme.colors.surfaceSecondary,
                        opacity: pressed ? 0.85 : 1,
                      },
                    ]}
                  >
                    <ThemedText
                      variant="caption"
                      style={{
                        color: active
                          ? theme.colors.foregroundInverted
                          : theme.colors.foregroundPrimary,
                        textTransform: "uppercase",
                        fontWeight: "600",
                      }}
                    >
                      {level}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingTop: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    marginBottom: 12,
  },
  headerTitle: {
    paddingRight: 16,
  },
  content: {
    paddingBottom: 32,
    paddingHorizontal: 16,
  },
  closeButton: {
    padding: 8,
  },
  sectionBlock: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    gap: 12,
  },
  sectionHeading: {
    gap: 4,
  },
  sectionTitle: {
    marginBottom: 4,
  },
  searchWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
  },
  section: {
    marginTop: 8,
  },
  recentChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8,
  },
  modelList: {
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
  modeRow: {
    flexDirection: "row",
    gap: 12,
  },
  modeCard: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  levelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  levelChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
});
