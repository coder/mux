import { Modal, View, Pressable, ActivityIndicator } from "react-native";
import { Surface } from "./Surface";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";

interface StartHereModalProps {
  visible: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isExecuting: boolean;
}

export function StartHereModal({ visible, onConfirm, onCancel, isExecuting }: StartHereModalProps) {
  const theme = useTheme();

  return (
    <Modal transparent visible={visible} animationType="fade">
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Surface
          style={{
            width: "80%",
            maxWidth: 400,
            padding: theme.spacing.lg,
          }}
        >
          <ThemedText variant="titleLarge" weight="bold" style={{ marginBottom: theme.spacing.sm }}>
            Start Here
          </ThemedText>

          <ThemedText variant="body" style={{ marginBottom: theme.spacing.lg }}>
            This will replace all chat history with this message. Continue?
          </ThemedText>

          <View style={{ flexDirection: "row", gap: theme.spacing.md }}>
            <Pressable
              onPress={onCancel}
              disabled={isExecuting}
              style={{
                flex: 1,
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surfaceElevated,
                alignItems: "center",
              }}
            >
              <ThemedText weight="medium">Cancel</ThemedText>
            </Pressable>

            <Pressable
              onPress={onConfirm}
              disabled={isExecuting}
              style={{
                flex: 1,
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.planMode,
                alignItems: "center",
              }}
            >
              {isExecuting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <ThemedText weight="bold" style={{ color: "#fff" }}>
                  OK
                </ThemedText>
              )}
            </Pressable>
          </View>
        </Surface>
      </View>
    </Modal>
  );
}
