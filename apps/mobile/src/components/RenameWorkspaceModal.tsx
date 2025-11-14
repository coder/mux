import type { JSX } from "react";
import { useState, useEffect } from "react";
import {
  Modal,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import { validateWorkspaceName } from "../utils/workspaceValidation";

interface RenameWorkspaceModalProps {
  visible: boolean;
  currentName: string;
  workspaceId: string;
  projectName: string;
  onClose: () => void;
  onRename: (workspaceId: string, newName: string) => Promise<void>;
}

export function RenameWorkspaceModal({
  visible,
  currentName,
  workspaceId,
  projectName,
  onClose,
  onRename,
}: RenameWorkspaceModalProps): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;

  const [newName, setNewName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (visible) {
      setNewName(currentName);
      setError(null);
      setIsSubmitting(false);
    }
  }, [visible, currentName]);

  // Validate on input change
  useEffect(() => {
    const trimmed = newName.trim();

    // No change - valid
    if (trimmed === currentName) {
      setError(null);
      return;
    }

    // Validate
    const result = validateWorkspaceName(trimmed);
    setError(result.valid ? null : (result.error ?? null));
  }, [newName, currentName]);

  const handleSubmit = async () => {
    const trimmed = newName.trim();

    // No-op check
    if (trimmed === currentName) {
      onClose();
      return;
    }

    // Validate
    const validation = validateWorkspaceName(trimmed);
    if (!validation.valid) {
      setError(validation.error ?? "Invalid name");
      return;
    }

    setIsSubmitting(true);
    try {
      await onRename(workspaceId, trimmed);
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to rename workspace");
    } finally {
      setIsSubmitting(false);
    }
  };

  const canSubmit = !error && newName.trim() !== currentName && !isSubmitting;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          justifyContent: Platform.OS === "ios" ? "flex-end" : "center",
        }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onPress={onClose}
          style={{
            flex: 1,
            justifyContent: Platform.OS === "ios" ? "flex-end" : "center",
          }}
        >
          <TouchableOpacity
            activeOpacity={1}
            onPress={(e) => e.stopPropagation()}
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: Platform.OS === "ios" ? 20 : 8,
              borderTopRightRadius: Platform.OS === "ios" ? 20 : 8,
              borderBottomLeftRadius: Platform.OS === "android" ? 8 : 0,
              borderBottomRightRadius: Platform.OS === "android" ? 8 : 0,
              padding: spacing.lg,
              ...(Platform.OS === "android" && {
                margin: spacing.lg,
                elevation: 8,
                shadowColor: "#000",
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.3,
                shadowRadius: 8,
              }),
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: spacing.lg,
              }}
            >
              <ThemedText
                variant="titleMedium"
                weight="semibold"
                style={{ color: theme.colors.foregroundPrimary }}
              >
                Rename Workspace
              </ThemedText>
              <TouchableOpacity onPress={onClose} disabled={isSubmitting}>
                <Ionicons
                  name="close"
                  size={24}
                  color={
                    isSubmitting ? theme.colors.foregroundMuted : theme.colors.foregroundPrimary
                  }
                />
              </TouchableOpacity>
            </View>

            {/* Project Name */}
            <View style={{ marginBottom: spacing.md }}>
              <ThemedText
                variant="caption"
                style={{ marginBottom: spacing.xs, color: theme.colors.foregroundSecondary }}
              >
                Project
              </ThemedText>
              <ThemedText
                variant="body"
                weight="medium"
                style={{ color: theme.colors.foregroundPrimary }}
              >
                {projectName}
              </ThemedText>
            </View>

            {/* Current Name */}
            <View style={{ marginBottom: spacing.md }}>
              <ThemedText
                variant="caption"
                style={{ marginBottom: spacing.xs, color: theme.colors.foregroundSecondary }}
              >
                Current Name
              </ThemedText>
              <ThemedText
                variant="body"
                weight="medium"
                style={{ color: theme.colors.foregroundMuted }}
              >
                {currentName}
              </ThemedText>
            </View>

            {/* New Name Input */}
            <View style={{ marginBottom: spacing.md }}>
              <ThemedText
                variant="caption"
                style={{ marginBottom: spacing.xs, color: theme.colors.foregroundSecondary }}
              >
                New Name
              </ThemedText>
              <TextInput
                value={newName}
                onChangeText={setNewName}
                onSubmitEditing={() => {
                  if (canSubmit) {
                    void handleSubmit();
                  }
                }}
                autoFocus
                selectTextOnFocus
                editable={!isSubmitting}
                placeholder="Enter new workspace name"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  backgroundColor: theme.colors.surfaceElevated,
                  color: theme.colors.foregroundPrimary,
                  paddingVertical: spacing.sm,
                  paddingHorizontal: spacing.md,
                  borderRadius: theme.radii.sm,
                  borderWidth: 1,
                  borderColor: error ? theme.colors.error : theme.colors.border,
                  fontSize: 16,
                }}
              />

              {/* Validation Error */}
              {error && (
                <View
                  style={{
                    marginTop: spacing.sm,
                    padding: spacing.sm,
                    backgroundColor: theme.colors.errorBackground,
                    borderRadius: theme.radii.xs,
                    borderWidth: 1,
                    borderColor: theme.colors.error,
                  }}
                >
                  <ThemedText variant="caption" style={{ color: theme.colors.error }}>
                    {error}
                  </ThemedText>
                </View>
              )}

              {/* Validation Hint */}
              {!error && newName.trim() !== currentName && (
                <ThemedText
                  variant="caption"
                  style={{ marginTop: spacing.sm, color: theme.colors.foregroundMuted }}
                >
                  Only lowercase letters, digits, underscore, and hyphen (1-64 characters)
                </ThemedText>
              )}
            </View>

            {/* Action Buttons */}
            <View
              style={{
                flexDirection: "row",
                gap: spacing.md,
                marginTop: spacing.md,
              }}
            >
              {/* Cancel Button */}
              <TouchableOpacity
                onPress={onClose}
                disabled={isSubmitting}
                style={{
                  flex: 1,
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                  borderRadius: theme.radii.md,
                  backgroundColor: theme.colors.surfaceElevated,
                  alignItems: "center",
                  opacity: isSubmitting ? 0.5 : 1,
                }}
              >
                <ThemedText
                  variant="body"
                  weight="semibold"
                  style={{ color: theme.colors.foregroundPrimary }}
                >
                  Cancel
                </ThemedText>
              </TouchableOpacity>

              {/* Rename Button */}
              <TouchableOpacity
                onPress={() => void handleSubmit()}
                disabled={!canSubmit}
                style={{
                  flex: 1,
                  paddingVertical: spacing.md,
                  paddingHorizontal: spacing.lg,
                  borderRadius: theme.radii.md,
                  backgroundColor: canSubmit ? theme.colors.accent : theme.colors.border,
                  alignItems: "center",
                  flexDirection: "row",
                  justifyContent: "center",
                  gap: spacing.sm,
                }}
              >
                {isSubmitting ? (
                  <>
                    <ActivityIndicator size="small" color="#fff" />
                    <ThemedText variant="body" weight="semibold" style={{ color: "#fff" }}>
                      Renaming...
                    </ThemedText>
                  </>
                ) : (
                  <ThemedText
                    variant="body"
                    weight="semibold"
                    style={{ color: canSubmit ? "#fff" : theme.colors.foregroundMuted }}
                  >
                    Rename
                  </ThemedText>
                )}
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}
