import type { JSX } from "react";
import { useMemo, useState, useEffect } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  TextInput,
  View,
} from "react-native";
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

type CollapsibleKey = "model" | "mode" | "reasoning" | "context";

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

interface SectionProps {
  title: string;
  subtitle?: string;
  collapsed: boolean;
  onToggle: () => void;
  children: JSX.Element | JSX.Element[];
}

function SectionCard(props: SectionProps): JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.sectionCard, { borderColor: theme.colors.border }]}> 
      <Pressable
        onPress={props.onToggle}
        style={({ pressed }) => [
          styles.sectionHeader,
          pressed ? { backgroundColor: theme.colors.surfaceSecondary } : null,
        ]}
      >
        <View style={{ flex: 1 }}>
          <ThemedText variant="label" weight="semibold">
            {props.title}
          </ThemedText>
          {props.subtitle && (
            <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
              {props.subtitle}
            </ThemedText>
          )}
        </View>
        <Ionicons
          name={props.collapsed ? "chevron-forward" : "chevron-down"}
          size={18}
          color={theme.colors.foregroundPrimary}
        />
      </Pressable>
      {!props.collapsed && <View style={styles.sectionBody}>{props.children}</View>}
    </View>
  );
}

export function RunSettingsSheet(props: RunSettingsSheetProps): JSX.Element {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<CollapsibleKey, boolean>>({
    model: false,
    mode: false,
    reasoning: false,
    context: false,
  });

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

  const toggleSection = (key: CollapsibleKey) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
          <ThemedText variant="titleMedium" weight="semibold">
            Run settings
          </ThemedText>
          <Pressable onPress={props.onClose} style={styles.closeButton}>
            <Ionicons name="close" size={20} color={theme.colors.foregroundPrimary} />
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
          <SectionCard
            title="Model"
            subtitle={formatModelSummary(props.selectedModel)}
            collapsed={collapsed.model}
            onToggle={() => toggleSection("model")}
          >
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
                        <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                          {formatModelSummary(item.id)}
                        </ThemedText>
                      </View>
                      {props.selectedModel === item.id && (
                        <Ionicons name="checkmark-circle" size={20} color={theme.colors.accent} />
                      )}
                    </Pressable>
                    {index < filteredModels.length - 1 ? (
                      <View
                        style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }}
                      />
                    ) : null}
                  </View>
                ))
              )}
            </View>
          </SectionCard>

          <SectionCard
            title="Mode"
            subtitle={props.mode === "plan" ? "Plan" : "Exec"}
            collapsed={collapsed.mode}
            onToggle={() => toggleSection("mode")}
          >
            <View style={styles.modeRow}>
              {(["plan", "exec"] as WorkspaceMode[]).map((modeOption) => (
                <Pressable
                  key={modeOption}
                  onPress={() => props.onSelectMode(modeOption)}
                  style={({ pressed }) => [
                    styles.modeCard,
                    {
                      borderColor:
                        props.mode === modeOption ? theme.colors.accent : theme.colors.border,
                      backgroundColor:
                        props.mode === modeOption
                          ? theme.colors.surface
                          : theme.colors.surfaceSecondary,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <ThemedText weight="semibold" style={{ textTransform: "capitalize" }}>
                    {modeOption}
                  </ThemedText>
                  <ThemedText variant="caption" style={{ color: theme.colors.foregroundMuted }}>
                    {modeOption === "plan" ? "Ask before executing" : "Act directly"}
                  </ThemedText>
                </Pressable>
              ))}
            </View>
          </SectionCard>

          <SectionCard
            title="Reasoning"
            subtitle={props.thinkingLevel.toUpperCase()}
            collapsed={collapsed.reasoning}
            onToggle={() => toggleSection("reasoning")}
          >
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
          </SectionCard>

          {props.supportsExtendedContext && (
            <SectionCard
              title="Context window"
              subtitle={props.use1MContext ? "1M tokens" : "128K tokens"}
              collapsed={collapsed.context}
              onToggle={() => toggleSection("context")}
            >
              <View style={styles.contextRow}>
                <ThemedText style={{ flex: 1 }}>
                  Enable 1M token context (Anthropic only)
                </ThemedText>
                <Switch
                  value={props.use1MContext}
                  onValueChange={props.onToggle1MContext}
                  trackColor={{ true: theme.colors.accent, false: theme.colors.border }}
                  thumbColor={theme.colors.surface}
                />
              </View>
            </SectionCard>
          )}
        </ScrollView>
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
  modelList: {
    maxHeight: 320,
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
  sectionCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    marginBottom: 16,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sectionBody: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 12,
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
  levelChip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
  },
  contextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
