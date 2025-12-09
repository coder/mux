import React, { useEffect, useRef } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { ThemedText } from "./ThemedText";

type FullscreenComposerModalProps = {
  visible: boolean;
  value: string;
  placeholder: string;
  isEditing: boolean;
  isSending: boolean;
  onChangeText: (text: string) => void;
  onClose: () => void;
  onSend: () => Promise<boolean> | boolean;
};

export function FullscreenComposerModal(props: FullscreenComposerModalProps) {
  const { visible, value, placeholder, isEditing, isSending, onChangeText, onClose, onSend } =
    props;
  const theme = useTheme();
  const spacing = theme.spacing;
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      const timeout = setTimeout(() => {
        inputRef.current?.focus();
      }, 150);
      return () => clearTimeout(timeout);
    }
    return undefined;
  }, [visible]);

  const disabled = isSending || value.trim().length === 0;

  return (
    <Modal
      animationType="slide"
      presentationStyle="fullScreen"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.surface,
            paddingTop: Math.max(insets.top, spacing.lg),
            paddingBottom: Math.max(insets.bottom, spacing.lg),
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.border,
            }}
          >
            <TouchableOpacity
              onPress={onClose}
              accessibilityRole="button"
              accessibilityLabel="Close full composer"
              style={{
                padding: spacing.sm,
                borderRadius: spacing.sm,
                backgroundColor: theme.colors.surfaceSecondary,
              }}
            >
              <Ionicons name="close" size={20} color={theme.colors.foregroundPrimary} />
            </TouchableOpacity>

            <ThemedText weight="semibold" style={{ color: theme.colors.foregroundPrimary }}>
              {isEditing ? "Edit message" : "Full composer"}
            </ThemedText>

            <TouchableOpacity
              onPress={() => {
                const result = onSend();
                if (result && typeof (result as Promise<boolean>).then === "function") {
                  void (result as Promise<boolean>);
                }
              }}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Send message"
              style={{
                paddingVertical: spacing.sm,
                paddingHorizontal: spacing.lg,
                borderRadius: theme.radii.sm,
                backgroundColor: disabled ? theme.colors.border : theme.colors.accent,
                opacity: disabled ? 0.6 : 1,
              }}
            >
              <ThemedText
                weight="semibold"
                style={{ color: disabled ? theme.colors.foregroundMuted : "#fff" }}
              >
                {isSending ? "Sending…" : isEditing ? "Save" : "Send"}
              </ThemedText>
            </TouchableOpacity>
          </View>

          {isEditing && (
            <View
              style={{
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                backgroundColor: theme.colors.accentMuted,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.border,
              }}
            >
              <ThemedText style={{ color: theme.colors.accent }}>
                Editing existing message
              </ThemedText>
            </View>
          )}

          <ScrollView
            contentContainerStyle={{ flexGrow: 1, padding: spacing.lg }}
            keyboardShouldPersistTaps="handled"
          >
            <View
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: theme.colors.inputBorder,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.inputBackground,
                padding: spacing.md,
                minHeight: 200,
              }}
            >
              <TextInput
                ref={inputRef}
                value={value}
                onChangeText={onChangeText}
                placeholder={placeholder}
                placeholderTextColor={theme.colors.foregroundMuted}
                style={{
                  color: theme.colors.foregroundPrimary,
                  fontSize: 16,
                  flex: 1,
                  textAlignVertical: "top",
                }}
                multiline
                autoCorrect={false}
                autoCapitalize="sentences"
                autoFocus={visible}
              />
            </View>

            <ThemedText
              variant="caption"
              style={{
                marginTop: spacing.md,
                color: theme.colors.foregroundMuted,
                textAlign: "center",
              }}
            >
              Draft comfortably here, then tap Send when you are ready.
            </ThemedText>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
