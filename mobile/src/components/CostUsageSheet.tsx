import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { useWorkspaceCost } from "../contexts/WorkspaceCostContext";
import type { ChatUsageDisplay } from "@/common/utils/tokens/usageAggregator";

interface CostUsageSheetProps {
  visible: boolean;
  onClose: () => void;
}

type ViewMode = "session" | "last";

const COMPONENT_ROWS: Array<{ key: keyof ChatUsageDisplay; label: string }> = [
  { key: "input", label: "Input" },
  { key: "cached", label: "Cached" },
  { key: "cacheCreate", label: "Cache Create" },
  { key: "output", label: "Output" },
  { key: "reasoning", label: "Reasoning" },
];

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return value.toLocaleString();
}

function formatCost(value: number | undefined): string {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "—";
  }
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

function renderComponentRow(
  label: string,
  component: ChatUsageDisplay[keyof ChatUsageDisplay],
  theme: ReturnType<typeof useTheme>
): JSX.Element | null {
  // Type guard: only ChatUsageComponent has .tokens property
  // The 'model' field is a string, so we skip it
  if (typeof component !== "object" || component === null || !("tokens" in component)) {
    return null;
  }

  return (
    <View style={styles.metricRow} key={label}>
      <Text style={[styles.metricLabel, { color: theme.colors.foregroundPrimary }]}>{label}</Text>
      <View style={styles.metricValues}>
        <Text style={[styles.metricValue, { color: theme.colors.foregroundPrimary }]}>
          {formatTokens(component.tokens)} tokens
        </Text>
        <Text style={[styles.metricValueSecondary, { color: theme.colors.foregroundMuted }]}>
          {formatCost(component.cost_usd)}
        </Text>
      </View>
    </View>
  );
}

export function CostUsageSheet({ visible, onClose }: CostUsageSheetProps): JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const {
    usageHistory,
    lastUsage,
    sessionUsage,
    totalTokens,
    isInitialized,
    consumers,
    refreshConsumers,
  } = useWorkspaceCost();
  const [viewMode, setViewMode] = useState<ViewMode>("session");
  const slideAnim = useRef(new Animated.Value(400)).current;

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 300,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: 400,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, slideAnim]);

  useEffect(() => {
    if (!visible) {
      setViewMode("session");
    }
  }, [visible]);

  const currentUsage = useMemo(() => {
    if (viewMode === "last") {
      return lastUsage;
    }
    return sessionUsage;
  }, [viewMode, lastUsage, sessionUsage]);

  const isConsumersLoading = consumers.status === "loading";
  const consumersError = consumers.status === "error" ? consumers.error : undefined;
  const consumersReady = consumers.status === "ready" ? consumers.stats : undefined;

  if (!visible) {
    return null;
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={StyleSheet.absoluteFill} />
      </Pressable>
      <View style={styles.outerContainer} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.colors.surface,
              transform: [{ translateY: slideAnim }],
              paddingBottom: Math.max(insets.bottom, 12),
            },
          ]}
        >
          <View style={styles.header}>
            <Text style={[styles.headerTitle, { color: theme.colors.foregroundPrimary }]}>
              Cost &amp; Usage
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={theme.colors.foregroundMuted} />
            </Pressable>
          </View>

          <View style={styles.toggleRow}>
            <Pressable
              style={[
                styles.toggleButton,
                {
                  backgroundColor:
                    viewMode === "session" ? theme.colors.accent : theme.colors.surfaceSecondary,
                },
              ]}
              onPress={() => setViewMode("session")}
            >
              <Text
                style={[
                  styles.toggleLabel,
                  {
                    color:
                      viewMode === "session"
                        ? theme.colors.background
                        : theme.colors.foregroundPrimary,
                  },
                ]}
              >
                Session
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.toggleButton,
                {
                  backgroundColor:
                    viewMode === "last" ? theme.colors.accent : theme.colors.surfaceSecondary,
                },
              ]}
              onPress={() => setViewMode("last")}
            >
              <Text
                style={[
                  styles.toggleLabel,
                  {
                    color:
                      viewMode === "last"
                        ? theme.colors.background
                        : theme.colors.foregroundPrimary,
                  },
                ]}
              >
                Last message
              </Text>
            </Pressable>
          </View>

          {!isInitialized ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={theme.colors.accent} />
              <Text style={[styles.loadingLabel, { color: theme.colors.foregroundMuted }]}>
                Loading usage…
              </Text>
            </View>
          ) : currentUsage ? (
            <ScrollView
              style={styles.scrollArea}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.summaryCard}>
                <Text style={[styles.summaryTitle, { color: theme.colors.foregroundPrimary }]}>
                  {viewMode === "session" ? "Session totals" : "Last response"}
                </Text>
                <Text style={[styles.summarySubtitle, { color: theme.colors.foregroundMuted }]}>
                  {totalTokens.toLocaleString()} tokens across {usageHistory.length} responses
                </Text>
              </View>

              {COMPONENT_ROWS.map(({ key, label }) =>
                renderComponentRow(label, currentUsage[key], theme)
              )}

              <View style={styles.sectionDivider} />

              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.colors.foregroundPrimary }]}>
                  Consumer breakdown
                </Text>
                {consumersReady ? (
                  <Text style={[styles.sectionSubtitle, { color: theme.colors.foregroundMuted }]}>
                    Tokenizer: {consumersReady.tokenizerName || "unknown"}
                  </Text>
                ) : null}
              </View>

              {consumersReady ? (
                consumersReady.consumers.length === 0 ? (
                  <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
                    No consumer data yet.
                  </Text>
                ) : (
                  <View style={styles.consumerTable}>
                    {consumersReady.consumers.map((consumer) => (
                      <View
                        key={consumer.name}
                        style={[styles.consumerRow, { borderBottomColor: theme.colors.border }]}
                      >
                        <Text
                          style={[styles.consumerName, { color: theme.colors.foregroundPrimary }]}
                        >
                          {consumer.name}
                        </Text>
                        <View style={styles.consumerMetrics}>
                          <Text
                            style={[
                              styles.consumerValue,
                              { color: theme.colors.foregroundPrimary },
                            ]}
                          >
                            {formatTokens(consumer.tokens)}
                          </Text>
                          <Text
                            style={[
                              styles.consumerPercentage,
                              { color: theme.colors.foregroundMuted },
                            ]}
                          >
                            {consumer.percentage.toFixed(1)}%
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )
              ) : (
                <Pressable
                  style={[
                    styles.loadButton,
                    {
                      backgroundColor: theme.colors.surfaceSecondary,
                      borderColor: theme.colors.border,
                    },
                  ]}
                  onPress={refreshConsumers}
                  disabled={isConsumersLoading}
                >
                  {isConsumersLoading ? (
                    <ActivityIndicator color={theme.colors.accent} />
                  ) : (
                    <Text
                      style={[styles.loadButtonLabel, { color: theme.colors.foregroundPrimary }]}
                    >
                      Load detailed breakdown
                    </Text>
                  )}
                </Pressable>
              )}

              {consumersError ? (
                <Text style={[styles.errorText, { color: theme.colors.danger }]}>
                  {consumersError}
                </Text>
              ) : null}
            </ScrollView>
          ) : (
            <Text style={[styles.emptyText, { color: theme.colors.foregroundMuted }]}>
              No usage data yet. Send a message to start tracking costs.
            </Text>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  outerContainer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    padding: 12,
  },
  sheet: {
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingTop: 16,
    maxHeight: "85%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  toggleRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 16,
  },
  toggleButton: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  toggleLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  loadingState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    gap: 12,
  },
  loadingLabel: {
    fontSize: 13,
  },
  scrollArea: {
    flexGrow: 0,
  },
  summaryCard: {
    marginBottom: 16,
  },
  summaryTitle: {
    fontSize: 16,
    fontWeight: "600",
  },
  summarySubtitle: {
    fontSize: 13,
    marginTop: 4,
  },
  metricRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  metricLabel: {
    fontSize: 14,
    fontWeight: "500",
  },
  metricValues: {
    alignItems: "flex-end",
  },
  metricValue: {
    fontSize: 14,
    fontWeight: "600",
  },
  metricValueSecondary: {
    fontSize: 12,
    marginTop: 2,
  },
  sectionDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginVertical: 16,
  },
  sectionHeader: {
    marginBottom: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: "600",
  },
  sectionSubtitle: {
    fontSize: 12,
  },
  emptyText: {
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 24,
  },
  consumerTable: {
    borderRadius: 12,
    overflow: "hidden",
  },
  consumerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  consumerName: {
    fontSize: 14,
    fontWeight: "500",
  },
  consumerMetrics: {
    alignItems: "flex-end",
  },
  consumerValue: {
    fontSize: 14,
    fontWeight: "600",
  },
  consumerPercentage: {
    fontSize: 12,
  },
  loadButton: {
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  loadButtonLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
  errorText: {
    fontSize: 12,
    marginTop: 8,
    textAlign: "center",
  },
});
