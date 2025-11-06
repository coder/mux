import type { JSX } from "react";
import { useState, useEffect } from "react";
import {
  Modal,
  View,
  TextInput,
  ScrollView,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
import { Surface } from "./Surface";
import type { Secret } from "../types";

interface SecretsModalProps {
  visible: boolean;
  projectPath: string;
  projectName: string;
  initialSecrets: Secret[];
  onClose: () => void;
  onSave: (secrets: Secret[]) => Promise<void>;
}

export function SecretsModal({
  visible,
  projectPath: _projectPath,
  projectName,
  initialSecrets,
  onClose,
  onSave,
}: SecretsModalProps): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;

  const [secrets, setSecrets] = useState<Secret[]>(initialSecrets);
  const [visibleSecrets, setVisibleSecrets] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);

  // Reset state when modal opens with new secrets
  useEffect(() => {
    if (visible) {
      setSecrets(initialSecrets);
      setVisibleSecrets(new Set());
    }
  }, [visible, initialSecrets]);

  const handleCancel = () => {
    setSecrets(initialSecrets);
    setVisibleSecrets(new Set());
    onClose();
  };

  const handleSave = async () => {
    setIsLoading(true);
    try {
      // Filter out empty secrets
      const validSecrets = secrets.filter((s) => s.key.trim() !== "" && s.value.trim() !== "");
      await onSave(validSecrets);
      onClose();
    } catch (err) {
      console.error("Failed to save secrets:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const addSecret = () => {
    setSecrets([...secrets, { key: "", value: "" }]);
  };

  const removeSecret = (index: number) => {
    setSecrets(secrets.filter((_, i) => i !== index));
    // Clean up visibility state
    const newVisible = new Set(visibleSecrets);
    newVisible.delete(index);
    setVisibleSecrets(newVisible);
  };

  const updateSecret = (index: number, field: "key" | "value", value: string) => {
    const newSecrets = [...secrets];
    // Auto-capitalize key field for env variable convention
    const processedValue = field === "key" ? value.toUpperCase() : value;
    newSecrets[index] = { ...newSecrets[index], [field]: processedValue };
    setSecrets(newSecrets);
  };

  const toggleVisibility = (index: number) => {
    const newVisible = new Set(visibleSecrets);
    if (newVisible.has(index)) {
      newVisible.delete(index);
    } else {
      newVisible.add(index);
    }
    setVisibleSecrets(newVisible);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={handleCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            padding: spacing.lg,
          }}
        >
          <Surface
            style={{
              width: "100%",
              maxWidth: 500,
              maxHeight: "80%",
              borderRadius: spacing.md,
              padding: spacing.lg,
            }}
          >
            {/* Header */}
            <View style={{ marginBottom: spacing.md }}>
              <ThemedText style={{ fontSize: 20, fontWeight: "bold", marginBottom: spacing.xs }}>
                Manage Secrets
              </ThemedText>
              <ThemedText style={{ fontSize: 14, opacity: 0.7 }}>
                Project: {projectName}
              </ThemedText>
            </View>

            {/* Info */}
            <View
              style={{
                backgroundColor: theme.colors.surface,
                padding: spacing.md,
                borderRadius: spacing.sm,
                marginBottom: spacing.md,
              }}
            >
              <ThemedText style={{ fontSize: 12, opacity: 0.8 }}>
                Secrets are stored in ~/.cmux/secrets.json (kept away from source code) but
                namespaced per project.
              </ThemedText>
              <ThemedText style={{ fontSize: 12, opacity: 0.8, marginTop: spacing.xs }}>
                Secrets are injected as environment variables to compute commands (e.g. Bash).
              </ThemedText>
            </View>

            {/* Secrets list */}
            <ScrollView
              style={{ flex: 1, marginBottom: spacing.md }}
              contentContainerStyle={{ paddingBottom: spacing.md }}
            >
              {secrets.length === 0 ? (
                <View style={{ padding: spacing.xl, alignItems: "center" }}>
                  <ThemedText style={{ fontSize: 13, opacity: 0.6 }}>
                    No secrets configured
                  </ThemedText>
                </View>
              ) : (
                secrets.map((secret, index) => (
                  <View
                    key={index}
                    style={{
                      marginBottom: spacing.md,
                      padding: spacing.md,
                      backgroundColor: theme.colors.surface,
                      borderRadius: spacing.sm,
                    }}
                  >
                    {/* Key input */}
                    <ThemedText style={{ fontSize: 11, opacity: 0.7, marginBottom: spacing.xs }}>
                      Key
                    </ThemedText>
                    <TextInput
                      value={secret.key}
                      onChangeText={(value) => updateSecret(index, "key", value)}
                      placeholder="SECRET_NAME"
                      placeholderTextColor={theme.colors.foregroundMuted}
                      editable={!isLoading}
                      style={{
                        backgroundColor: theme.colors.background,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: spacing.sm,
                        paddingHorizontal: spacing.md,
                        paddingVertical: spacing.sm,
                        fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                        fontSize: 13,
                        color: theme.colors.foregroundPrimary,
                        marginBottom: spacing.sm,
                      }}
                    />

                    {/* Value input with visibility toggle */}
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <View style={{ flex: 1 }}>
                        <ThemedText
                          style={{ fontSize: 11, opacity: 0.7, marginBottom: spacing.xs }}
                        >
                          Value
                        </ThemedText>
                        <TextInput
                          value={secret.value}
                          onChangeText={(value) => updateSecret(index, "value", value)}
                          placeholder="secret value"
                          placeholderTextColor={theme.colors.foregroundMuted}
                          secureTextEntry={!visibleSecrets.has(index)}
                          editable={!isLoading}
                          style={{
                            backgroundColor: theme.colors.background,
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            borderRadius: spacing.sm,
                            paddingHorizontal: spacing.md,
                            paddingVertical: spacing.sm,
                            fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
                            fontSize: 13,
                            color: theme.colors.foregroundPrimary,
                          }}
                        />
                      </View>

                      {/* Visibility toggle */}
                      <TouchableOpacity
                        onPress={() => toggleVisibility(index)}
                        disabled={isLoading}
                        style={{
                          marginLeft: spacing.sm,
                          padding: spacing.sm,
                          alignSelf: "flex-end",
                        }}
                      >
                        <Ionicons
                          name={visibleSecrets.has(index) ? "eye-off" : "eye"}
                          size={20}
                          color={theme.colors.foregroundMuted}
                        />
                      </TouchableOpacity>

                      {/* Remove button */}
                      <TouchableOpacity
                        onPress={() => removeSecret(index)}
                        disabled={isLoading}
                        style={{
                          marginLeft: spacing.xs,
                          padding: spacing.sm,
                          alignSelf: "flex-end",
                        }}
                      >
                        <Ionicons name="trash-outline" size={20} color={theme.colors.danger} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </ScrollView>

            {/* Add secret button */}
            <TouchableOpacity
              onPress={addSecret}
              disabled={isLoading}
              style={{
                borderWidth: 1,
                borderColor: theme.colors.border,
                borderStyle: "dashed",
                borderRadius: spacing.sm,
                padding: spacing.md,
                alignItems: "center",
                marginBottom: spacing.md,
              }}
            >
              <ThemedText style={{ fontSize: 13 }}>+ Add Secret</ThemedText>
            </TouchableOpacity>

            {/* Action buttons */}
            <View style={{ flexDirection: "row", gap: spacing.md }}>
              <TouchableOpacity
                onPress={handleCancel}
                disabled={isLoading}
                style={{
                  flex: 1,
                  padding: spacing.md,
                  borderRadius: spacing.sm,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  alignItems: "center",
                }}
              >
                <ThemedText style={{ fontSize: 14 }}>Cancel</ThemedText>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => void handleSave()}
                disabled={isLoading}
                style={{
                  flex: 1,
                  padding: spacing.md,
                  borderRadius: spacing.sm,
                  backgroundColor: theme.colors.accent,
                  alignItems: "center",
                }}
              >
                {isLoading ? (
                  <ActivityIndicator color={theme.colors.foregroundInverted} />
                ) : (
                  <ThemedText style={{ fontSize: 14, fontWeight: "600", color: theme.colors.foregroundInverted }}>Save</ThemedText>
                )}
              </TouchableOpacity>
            </View>
          </Surface>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
