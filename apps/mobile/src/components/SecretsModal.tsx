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
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";
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
      onRequestClose={handleCancel}
      presentationStyle="pageSheet"
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.background,
          }}
        >
          <View
            style={{
              flex: 1,
            }}
          >
            {/* Header */}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                paddingHorizontal: spacing.md,
                paddingTop: spacing.lg,
                paddingBottom: spacing.lg,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.borderSubtle,
              }}
            >
              <TouchableOpacity
                onPress={handleCancel}
                disabled={isLoading}
                style={{ paddingHorizontal: spacing.sm }}
              >
                <ThemedText style={{ fontSize: 17, color: theme.colors.accent }}>Cancel</ThemedText>
              </TouchableOpacity>
              <ThemedText style={{ fontSize: 17, fontWeight: "600" }}>Secrets</ThemedText>
              <TouchableOpacity
                onPress={() => void handleSave()}
                disabled={isLoading}
                style={{ paddingHorizontal: spacing.sm }}
              >
                <ThemedText
                  style={{
                    fontSize: 17,
                    color: isLoading ? theme.colors.foregroundMuted : theme.colors.accent,
                    fontWeight: "600",
                  }}
                >
                  {isLoading ? "Saving..." : "Done"}
                </ThemedText>
              </TouchableOpacity>
            </View>

            {/* Project name */}
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                backgroundColor: theme.colors.surfaceSunken,
              }}
            >
              <ThemedText style={{ fontSize: 13, opacity: 0.7, marginBottom: 2 }}>
                PROJECT
              </ThemedText>
              <ThemedText style={{ fontSize: 15 }}>{projectName}</ThemedText>
            </View>

            {/* Secrets list */}
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{
                padding: spacing.lg,
              }}
            >
              {secrets.length === 0 ? (
                <View style={{ paddingVertical: spacing.xxl, alignItems: "center" }}>
                  <Ionicons name="key-outline" size={48} color={theme.colors.foregroundMuted} />
                  <ThemedText
                    style={{
                      fontSize: 15,
                      opacity: 0.6,
                      marginTop: spacing.md,
                      textAlign: "center",
                    }}
                  >
                    No secrets yet
                  </ThemedText>
                  <ThemedText
                    style={{
                      fontSize: 13,
                      opacity: 0.5,
                      marginTop: spacing.xs,
                      textAlign: "center",
                    }}
                  >
                    Secrets are injected as environment variables
                  </ThemedText>
                </View>
              ) : (
                secrets.map((secret, index) => (
                  <View
                    key={index}
                    style={{
                      marginBottom: spacing.lg,
                      backgroundColor: theme.colors.surface,
                      borderRadius: 12,
                      padding: spacing.md,
                      borderWidth: 1,
                      borderColor: theme.colors.borderSubtle,
                    }}
                  >
                    {/* Key input */}
                    <View style={{ marginBottom: spacing.md }}>
                      <ThemedText
                        style={{
                          fontSize: 12,
                          opacity: 0.6,
                          marginBottom: spacing.xs,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}
                      >
                        Key
                      </ThemedText>
                      <TextInput
                        value={secret.key}
                        onChangeText={(value) => updateSecret(index, "key", value)}
                        placeholder="API_KEY"
                        placeholderTextColor={theme.colors.foregroundMuted}
                        editable={!isLoading}
                        style={{
                          backgroundColor: theme.colors.background,
                          borderWidth: 1,
                          borderColor: theme.colors.border,
                          borderRadius: 8,
                          paddingHorizontal: spacing.md,
                          paddingVertical: 12,
                          fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                          fontSize: 14,
                          color: theme.colors.foregroundPrimary,
                        }}
                      />
                    </View>

                    {/* Value input with controls */}
                    <View style={{ marginBottom: spacing.sm }}>
                      <ThemedText
                        style={{
                          fontSize: 12,
                          opacity: 0.6,
                          marginBottom: spacing.xs,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                        }}
                      >
                        Value
                      </ThemedText>
                      <View style={{ position: "relative" }}>
                        <TextInput
                          value={secret.value}
                          onChangeText={(value) => updateSecret(index, "value", value)}
                          placeholder="secret_value"
                          placeholderTextColor={theme.colors.foregroundMuted}
                          secureTextEntry={!visibleSecrets.has(index)}
                          editable={!isLoading}
                          style={{
                            backgroundColor: theme.colors.background,
                            borderWidth: 1,
                            borderColor: theme.colors.border,
                            borderRadius: 8,
                            paddingHorizontal: spacing.md,
                            paddingVertical: 12,
                            paddingRight: 48,
                            fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                            fontSize: 14,
                            color: theme.colors.foregroundPrimary,
                          }}
                        />
                        {/* Visibility toggle - positioned inside input */}
                        <TouchableOpacity
                          onPress={() => toggleVisibility(index)}
                          disabled={isLoading}
                          style={{
                            position: "absolute",
                            right: 12,
                            top: 0,
                            bottom: 0,
                            justifyContent: "center",
                          }}
                        >
                          <Ionicons
                            name={visibleSecrets.has(index) ? "eye-off-outline" : "eye-outline"}
                            size={22}
                            color={theme.colors.foregroundMuted}
                          />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Delete button */}
                    <TouchableOpacity
                      onPress={() => removeSecret(index)}
                      disabled={isLoading}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        paddingVertical: spacing.sm,
                        marginTop: spacing.xs,
                      }}
                    >
                      <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
                      <ThemedText
                        style={{
                          fontSize: 14,
                          color: theme.colors.danger,
                          marginLeft: spacing.xs,
                        }}
                      >
                        Remove
                      </ThemedText>
                    </TouchableOpacity>
                  </View>
                ))
              )}

              {/* Add secret button */}
              <TouchableOpacity
                onPress={addSecret}
                disabled={isLoading}
                style={{
                  backgroundColor: theme.colors.surface,
                  borderWidth: 2,
                  borderColor: theme.colors.accent,
                  borderStyle: "dashed",
                  borderRadius: 12,
                  paddingVertical: spacing.lg,
                  alignItems: "center",
                  marginTop: secrets.length > 0 ? spacing.sm : 0,
                }}
              >
                <Ionicons name="add-circle-outline" size={24} color={theme.colors.accent} />
                <ThemedText
                  style={{
                    fontSize: 15,
                    color: theme.colors.accent,
                    marginTop: spacing.xs,
                    fontWeight: "500",
                  }}
                >
                  Add Secret
                </ThemedText>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
