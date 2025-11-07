import type { JSX } from "react";
import { memo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../theme";

interface ReviewFiltersProps {
  diffBase: string;
  includeUncommitted: boolean;
  onChangeDiffBase: (base: string) => void;
  onChangeIncludeUncommitted: (include: boolean) => void;
}

const COMMON_BASES = [
  { value: "main", label: "main" },
  { value: "master", label: "master" },
  { value: "origin/main", label: "origin/main" },
  { value: "origin/master", label: "origin/master" },
  { value: "HEAD", label: "Uncommitted only" },
  { value: "--staged", label: "Staged only" },
];

export const ReviewFilters = memo<ReviewFiltersProps>(
  ({ diffBase, includeUncommitted, onChangeDiffBase, onChangeIncludeUncommitted }) => {
    const theme = useTheme();
    const [showModal, setShowModal] = useState(false);
    const [customBase, setCustomBase] = useState("");

    const currentBaseLabel =
      COMMON_BASES.find((b) => b.value === diffBase)?.label || diffBase;

    return (
      <>
        <View style={[styles.container, { backgroundColor: theme.colors.surfaceSecondary }]}>
          {/* Diff Base Selector */}
          <Pressable
            style={[styles.filterButton, { backgroundColor: theme.colors.surface }]}
            onPress={() => setShowModal(true)}
          >
            <Text style={[styles.filterLabel, { color: theme.colors.foregroundSecondary }]}>
              Base:
            </Text>
            <Text style={[styles.filterValue, { color: theme.colors.foregroundPrimary }]}>
              {currentBaseLabel}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.foregroundSecondary} />
          </Pressable>

          {/* Include Uncommitted Toggle */}
          <Pressable
            style={[
              styles.toggleButton,
              {
                backgroundColor: includeUncommitted
                  ? theme.colors.accent
                  : theme.colors.surface,
              },
            ]}
            onPress={() => onChangeIncludeUncommitted(!includeUncommitted)}
          >
            <Text
              style={[
                styles.toggleText,
                {
                  color: includeUncommitted
                    ? theme.colors.foregroundInverted
                    : theme.colors.foregroundPrimary,
                },
              ]}
            >
              + Uncommitted
            </Text>
          </Pressable>
        </View>

        {/* Base Selection Modal */}
        <Modal
          visible={showModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowModal(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setShowModal(false)}>
            <View
              style={[styles.modalContent, { backgroundColor: theme.colors.surface }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={[styles.modalHeader, { borderBottomColor: theme.colors.border }]}>
                <Text style={[styles.modalTitle, { color: theme.colors.foregroundPrimary }]}>
                  Compare against
                </Text>
                <Pressable onPress={() => setShowModal(false)} style={styles.closeButton}>
                  <Ionicons name="close" size={24} color={theme.colors.foregroundSecondary} />
                </Pressable>
              </View>

              <ScrollView style={styles.optionsList}>
                {COMMON_BASES.map((base) => (
                  <Pressable
                    key={base.value}
                    style={[
                      styles.option,
                      { borderBottomColor: theme.colors.border },
                      diffBase === base.value && {
                        backgroundColor: theme.colors.accentMuted,
                      },
                    ]}
                    onPress={() => {
                      onChangeDiffBase(base.value);
                      setShowModal(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        {
                          color:
                            diffBase === base.value
                              ? theme.colors.accent
                              : theme.colors.foregroundPrimary,
                        },
                      ]}
                    >
                      {base.label}
                    </Text>
                    {diffBase === base.value && (
                      <Ionicons name="checkmark" size={20} color={theme.colors.accent} />
                    )}
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      </>
    );
  }
);

ReviewFilters.displayName = "ReviewFilters";

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  filterButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    gap: 6,
    flex: 1,
  },
  filterLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  filterValue: {
    fontSize: 13,
    fontWeight: "600",
    flex: 1,
  },
  toggleButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
  },
  toggleText: {
    fontSize: 13,
    fontWeight: "600",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  modalContent: {
    width: "100%",
    maxWidth: 400,
    maxHeight: 500,
    borderRadius: 12,
    overflow: "hidden",
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "600",
  },
  closeButton: {
    padding: 4,
  },
  optionsList: {
    maxHeight: 400,
  },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    borderBottomWidth: 1,
  },
  optionText: {
    fontSize: 15,
    fontWeight: "500",
  },
});

// Log when modal state changes
