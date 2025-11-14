import type { JSX } from "react";
import { memo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../theme";
import type { FileTreeNode } from "../../utils/git/numstatParser";

interface ReviewFiltersProps {
  diffBase: string;
  includeUncommitted: boolean;
  selectedFilePath: string | null;
  fileTree: FileTreeNode | null;
  onChangeDiffBase: (base: string) => void;
  onChangeIncludeUncommitted: (include: boolean) => void;
  onChangeSelectedFile: (filePath: string | null) => void;
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
  ({
    diffBase,
    includeUncommitted,
    selectedFilePath,
    fileTree,
    onChangeDiffBase,
    onChangeIncludeUncommitted,
    onChangeSelectedFile,
  }) => {
    const theme = useTheme();
    const [showBaseModal, setShowBaseModal] = useState(false);
    const [showFileModal, setShowFileModal] = useState(false);
    const [customBase, setCustomBase] = useState("");

    const currentBaseLabel = COMMON_BASES.find((b) => b.value === diffBase)?.label || diffBase;

    // Extract file name from path for display
    const selectedFileName = selectedFilePath
      ? selectedFilePath.split("/").pop() || selectedFilePath
      : null;

    // Flatten file tree for modal display
    const flattenTree = (node: FileTreeNode): Array<{ path: string; name: string }> => {
      const items: Array<{ path: string; name: string }> = [];

      if (!node.isDirectory) {
        // Leaf node (file) - has a path
        items.push({ path: node.path, name: node.name });
      } else if (node.children) {
        // Directory node - recurse into children array
        for (const childNode of node.children) {
          items.push(...flattenTree(childNode));
        }
      }

      return items;
    };

    const allFiles = fileTree ? flattenTree(fileTree) : [];

    return (
      <>
        <View style={[styles.container, { backgroundColor: theme.colors.surfaceSecondary }]}>
          {/* Diff Base Selector */}
          <Pressable
            style={[styles.filterButton, { backgroundColor: theme.colors.surface }]}
            onPress={() => setShowBaseModal(true)}
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
                backgroundColor: includeUncommitted ? theme.colors.accent : theme.colors.surface,
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

        {/* File Filter Selector (second row) */}
        <View
          style={[
            styles.fileFilterContainer,
            { backgroundColor: theme.colors.surfaceSecondary, borderTopColor: theme.colors.border },
          ]}
        >
          <Pressable
            style={[styles.filterButton, { backgroundColor: theme.colors.surface }]}
            onPress={() => setShowFileModal(true)}
          >
            <Ionicons name="document-text" size={16} color={theme.colors.foregroundSecondary} />
            <Text style={[styles.filterLabel, { color: theme.colors.foregroundSecondary }]}>
              File:
            </Text>
            <Text style={[styles.filterValue, { color: theme.colors.foregroundPrimary }]}>
              {selectedFileName || "All files"}
            </Text>
            <Ionicons name="chevron-down" size={16} color={theme.colors.foregroundSecondary} />
          </Pressable>

          {selectedFilePath && (
            <Pressable
              style={[styles.clearButton, { backgroundColor: theme.colors.surface }]}
              onPress={() => onChangeSelectedFile(null)}
            >
              <Ionicons name="close" size={16} color={theme.colors.foregroundSecondary} />
            </Pressable>
          )}
        </View>

        {/* Base Selection Modal */}
        <Modal
          visible={showBaseModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowBaseModal(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setShowBaseModal(false)}>
            <View
              style={[styles.modalContent, { backgroundColor: theme.colors.surface }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={[styles.modalHeader, { borderBottomColor: theme.colors.border }]}>
                <Text style={[styles.modalTitle, { color: theme.colors.foregroundPrimary }]}>
                  Compare against
                </Text>
                <Pressable onPress={() => setShowBaseModal(false)} style={styles.closeButton}>
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
                      setShowBaseModal(false);
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

        {/* File Selection Modal */}
        <Modal
          visible={showFileModal}
          transparent
          animationType="fade"
          onRequestClose={() => setShowFileModal(false)}
        >
          <Pressable style={styles.modalOverlay} onPress={() => setShowFileModal(false)}>
            <View
              style={[styles.modalContent, { backgroundColor: theme.colors.surface }]}
              onStartShouldSetResponder={() => true}
            >
              <View style={[styles.modalHeader, { borderBottomColor: theme.colors.border }]}>
                <Text style={[styles.modalTitle, { color: theme.colors.foregroundPrimary }]}>
                  Filter by file
                </Text>
                <Pressable onPress={() => setShowFileModal(false)} style={styles.closeButton}>
                  <Ionicons name="close" size={24} color={theme.colors.foregroundSecondary} />
                </Pressable>
              </View>

              <ScrollView style={styles.optionsList}>
                {/* All files option */}
                <Pressable
                  style={[
                    styles.option,
                    { borderBottomColor: theme.colors.border },
                    selectedFilePath === null && {
                      backgroundColor: theme.colors.accentMuted,
                    },
                  ]}
                  onPress={() => {
                    onChangeSelectedFile(null);
                    setShowFileModal(false);
                  }}
                >
                  <Text
                    style={[
                      styles.optionText,
                      {
                        color:
                          selectedFilePath === null
                            ? theme.colors.accent
                            : theme.colors.foregroundPrimary,
                        fontWeight: "600",
                      },
                    ]}
                  >
                    All files
                  </Text>
                  {selectedFilePath === null && (
                    <Ionicons name="checkmark" size={20} color={theme.colors.accent} />
                  )}
                </Pressable>

                {/* Individual files */}
                {allFiles.map((file) => (
                  <Pressable
                    key={file.path}
                    style={[
                      styles.option,
                      { borderBottomColor: theme.colors.border },
                      selectedFilePath === file.path && {
                        backgroundColor: theme.colors.accentMuted,
                      },
                    ]}
                    onPress={() => {
                      onChangeSelectedFile(file.path);
                      setShowFileModal(false);
                    }}
                  >
                    <Text
                      style={[
                        styles.optionText,
                        {
                          color:
                            selectedFilePath === file.path
                              ? theme.colors.accent
                              : theme.colors.foregroundPrimary,
                        },
                      ]}
                    >
                      {file.path}
                    </Text>
                    {selectedFilePath === file.path && (
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
  fileFilterContainer: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    paddingTop: 0,
    gap: 8,
    borderTopWidth: 1,
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
  clearButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
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
