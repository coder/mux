import type { JSX, ReactNode } from "react";
import React, { useMemo, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import type { DisplayedMessage } from "@/common/types/message";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { Surface } from "../components/Surface";
import { ThemedText } from "../components/ThemedText";
import { useTheme } from "../theme";
import { assert } from "../utils/assert";

export interface MessageBubbleButtonConfig {
  label: string;
  onPress: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  active?: boolean;
}

interface MessageBubbleProps {
  label?: ReactNode;
  rightLabel?: ReactNode;
  variant?: "assistant" | "user";
  message: DisplayedMessage;
  buttons?: MessageBubbleButtonConfig[];
  children: ReactNode;
  backgroundEffect?: ReactNode;
}

export function MessageBubble(props: MessageBubbleProps): JSX.Element {
  const theme = useTheme();
  const [showJson, setShowJson] = useState(false);
  const variant = props.variant ?? "assistant";

  const timestamp = useMemo(() => {
    const ts = "timestamp" in props.message ? props.message.timestamp : undefined;
    if (typeof ts === "number") {
      return formatTimestamp(ts);
    }
    return null;
  }, [props.message]);

  const isLastPartOfMessage = useMemo(() => {
    // Simply check if this is marked as the last part
    // Don't require isPartial === false, as that flag can be stale during streaming
    return "isLastPartOfMessage" in props.message && props.message.isLastPartOfMessage === true;
  }, [props.message]);

  const showMetaRow = variant === "user" || isLastPartOfMessage;

  const metaButtons: MessageBubbleButtonConfig[] = useMemo(() => {
    const provided = props.buttons ?? [];
    return [
      ...provided,
      {
        label: showJson ? "Hide JSON" : "Show JSON",
        onPress: () => setShowJson((prev) => !prev),
        active: showJson,
      },
    ];
  }, [props.buttons, showJson]);

  return (
    <View style={[styles.container, variant === "user" ? styles.alignUser : undefined]}>
      <Surface
        variant="plain"
        style={[
          styles.surface,
          variant === "user" ? styles.userSurface : styles.assistantSurface,
          { borderColor: theme.colors.border },
        ]}
      >
        {props.backgroundEffect}
        {showJson ? (
          <ScrollView style={styles.jsonScroll} showsVerticalScrollIndicator>
            <Text style={[styles.jsonText, { color: theme.colors.foregroundSecondary }]}>
              {JSON.stringify(props.message, null, 2)}
            </Text>
          </ScrollView>
        ) : (
          props.children
        )}
      </Surface>

      {showMetaRow && (
        <View
          style={[
            styles.metaRow,
            variant === "user" ? styles.metaRowUser : styles.metaRowAssistant,
          ]}
        >
          <View style={styles.buttonsRow}>
            {metaButtons.map((button, index) => (
              <IconActionButton key={`${button.label}-${index}`} button={button} />
            ))}
          </View>
          <View style={styles.metaRight}>
            {props.rightLabel}
            {props.label ? <View style={styles.labelContainer}>{props.label}</View> : null}
            {timestamp ? (
              <ThemedText variant="caption" style={styles.timestampText}>
                {timestamp}
              </ThemedText>
            ) : null}
          </View>
        </View>
      )}
    </View>
  );
}

interface IconActionButtonProps {
  button: MessageBubbleButtonConfig;
}

function IconActionButton({ button }: IconActionButtonProps): JSX.Element {
  const theme = useTheme();
  assert(typeof button.onPress === "function", "MessageBubble button requires onPress handler");

  const content = button.icon ? (
    button.icon
  ) : (
    <ThemedText
      variant="caption"
      style={{
        fontWeight: button.active ? "700" : "500",
        color: button.active ? theme.colors.accent : theme.colors.foregroundSecondary,
      }}
    >
      {button.label}
    </ThemedText>
  );

  return (
    <TouchableOpacity
      disabled={button.disabled}
      onPress={button.onPress}
      style={[
        styles.actionButton,
        button.active && { borderColor: theme.colors.accent },
        button.disabled && { opacity: 0.5 },
      ]}
      accessibilityRole="button"
      accessibilityLabel={button.label}
    >
      {content}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    marginBottom: 12,
  },
  alignUser: {
    alignItems: "flex-end",
  },
  surface: {
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  assistantSurface: {
    backgroundColor: "rgba(255, 255, 255, 0.04)",
  },
  userSurface: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
  },
  metaRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 8,
  },
  metaRowUser: {
    alignSelf: "flex-end",
  },
  metaRowAssistant: {
    alignSelf: "flex-start",
  },
  buttonsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  metaRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  actionButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255, 255, 255, 0.1)",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  labelContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  timestampText: {
    opacity: 0.7,
  },
  jsonScroll: {
    maxHeight: 260,
  },
  jsonText: {
    fontFamily: "Courier",
    fontSize: 12,
  },
});
