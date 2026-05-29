import { memo, useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
  Platform,
  Vibration,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
import { BlurView } from "expo-blur";

interface ActionSheetItem {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  badge?: number | string;
  onPress: () => void;
  destructive?: boolean;
}

interface WorkspaceActionSheetProps {
  visible: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
}

export const WorkspaceActionSheet = memo<WorkspaceActionSheetProps>(
  ({ visible, onClose, items }) => {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const slideAnim = useRef(new Animated.Value(400)).current; // Start off-screen

    // Animate in/out when visibility changes
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

    const handleItemPress = useCallback(
      (item: ActionSheetItem) => {
        // iOS haptic feedback
        if (Platform.OS === "ios") {
          Vibration.vibrate(1);
        }
        onClose();
        // Slight delay for close animation before action
        setTimeout(() => item.onPress(), 150);
      },
      [onClose]
    );

    if (!visible) return null;

    return (
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={onClose}
        statusBarTranslucent
        presentationStyle="overFullScreen"
      >
        {/* Backdrop - fades in */}
        <Pressable style={styles.backdrop} onPress={onClose}>
          <BlurView intensity={20} style={StyleSheet.absoluteFill} tint="dark" />
        </Pressable>

        {/* Action Sheet - slides up */}
        <View style={styles.container} pointerEvents="box-none">
          <Animated.View
            style={[
              styles.sheetWrapper,
              {
                transform: [{ translateY: slideAnim }],
                paddingBottom: insets.bottom || 8,
              },
            ]}
          >
            {/* Main actions */}
            <View style={[styles.actionsGroup, { backgroundColor: theme.colors.surface }]}>
              {items.map((item, index) => (
                <Pressable
                  key={item.id}
                  style={({ pressed }) => [
                    styles.actionItem,
                    index > 0 && [styles.actionItemBorder, { borderTopColor: theme.colors.border }],
                    pressed && { backgroundColor: theme.colors.surfaceSecondary },
                  ]}
                  onPress={() => handleItemPress(item)}
                >
                  <Ionicons
                    name={item.icon}
                    size={22}
                    color={item.destructive ? "#FF3B30" : theme.colors.accent}
                    style={styles.actionIcon}
                  />
                  <Text
                    style={[
                      styles.actionLabel,
                      {
                        color: item.destructive ? "#FF3B30" : theme.colors.foregroundPrimary,
                      },
                    ]}
                  >
                    {item.label}
                  </Text>
                  {item.badge !== undefined && (
                    <View style={[styles.badge, { backgroundColor: theme.colors.error }]}>
                      <Text style={styles.badgeText}>{item.badge}</Text>
                    </View>
                  )}
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={theme.colors.foregroundTertiary}
                    style={styles.chevron}
                  />
                </Pressable>
              ))}
            </View>

            {/* Cancel button */}
            <Pressable
              style={({ pressed }) => [
                styles.cancelButton,
                { backgroundColor: theme.colors.surface },
                pressed && { backgroundColor: theme.colors.surfaceSecondary },
              ]}
              onPress={onClose}
            >
              <Text style={[styles.cancelLabel, { color: theme.colors.accent }]}>Cancel</Text>
            </Pressable>
          </Animated.View>
        </View>
      </Modal>
    );
  }
);

WorkspaceActionSheet.displayName = "WorkspaceActionSheet";

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.4)",
  },
  container: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "flex-end",
    padding: 8,
  },
  sheetWrapper: {
    gap: 8,
  },
  actionsGroup: {
    borderRadius: 14,
    overflow: "hidden",
  },
  actionItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 16,
    paddingHorizontal: 16,
    minHeight: 57,
  },
  actionItemBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionIcon: {
    marginRight: 12,
  },
  actionLabel: {
    fontSize: 17,
    fontWeight: "400",
    flex: 1,
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 8,
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
  },
  chevron: {
    opacity: 0.3,
  },
  cancelButton: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    minHeight: 57,
    justifyContent: "center",
  },
  cancelLabel: {
    fontSize: 17,
    fontWeight: "600",
  },
});
