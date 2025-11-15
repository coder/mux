import type { JSX } from "react";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { Surface } from "./Surface";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";
import { StartHereModal } from "./StartHereModal";
import { MarkdownMessageBody } from "./MarkdownMessageBody";

interface ProposePlanCardProps {
  title: string;
  plan: string;
  status: "pending" | "executing" | "completed" | "failed" | "interrupted";
  workspaceId?: string;
  onStartHere?: () => Promise<void>;
}

export function ProposePlanCard({
  title,
  plan,
  status,
  workspaceId,
  onStartHere,
}: ProposePlanCardProps): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const [showRaw, setShowRaw] = useState(false);
  const markdownOverrides = useMemo(
    () => ({
      body: {
        color: theme.colors.foregroundPrimary,
        fontSize: 14,
        lineHeight: 20,
      },
      heading1: {
        color: theme.colors.planModeLight,
        fontSize: 18,
        fontWeight: "bold",
        marginTop: spacing.sm,
        marginBottom: spacing.xs,
      },
      heading2: {
        color: theme.colors.planModeLight,
        fontSize: 16,
        fontWeight: "600",
        marginTop: spacing.sm,
        marginBottom: spacing.xs,
      },
      heading3: {
        color: theme.colors.foregroundPrimary,
        fontSize: 14,
        fontWeight: "600",
        marginTop: spacing.xs,
        marginBottom: spacing.xs,
      },
      paragraph: {
        marginTop: 0,
        marginBottom: spacing.sm,
      },
      code_inline: {
        backgroundColor: "rgba(31, 107, 184, 0.15)",
        color: theme.colors.planModeLight,
        fontSize: 12,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 3,
        fontFamily: theme.typography.familyMono,
      },
      code_block: {
        backgroundColor: theme.colors.background,
        borderRadius: theme.radii.sm,
        padding: spacing.sm,
        fontFamily: theme.typography.familyMono,
        fontSize: 12,
      },
      fence: {
        backgroundColor: theme.colors.background,
        borderRadius: theme.radii.sm,
        padding: spacing.sm,
        marginVertical: spacing.xs,
      },
      bullet_list: {
        marginVertical: spacing.xs,
      },
      ordered_list: {
        marginVertical: spacing.xs,
      },
    }),
    [spacing, theme]
  );
  const [copied, setCopied] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [isStartingHere, setIsStartingHere] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(plan);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleStartHere = async () => {
    if (!onStartHere || isStartingHere) return;

    setIsStartingHere(true);
    try {
      await onStartHere();
      setShowModal(false);
    } catch (error) {
      console.error("Start here error:", error);
    } finally {
      setIsStartingHere(false);
    }
  };

  const buttonStyle = (active: boolean) => ({
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: theme.radii.sm,
    backgroundColor: active ? "rgba(31, 107, 184, 0.2)" : theme.colors.planModeAlpha,
    borderWidth: 1,
    borderColor: active ? theme.colors.planMode : "rgba(31, 107, 184, 0.3)",
  });

  return (
    <Surface
      variant="plain"
      style={{
        padding: spacing.md,
        marginBottom: spacing.md,
        backgroundColor: "rgba(31, 107, 184, 0.08)",
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.planMode,
      }}
      accessibilityRole="summary"
    >
      {/* Header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          marginBottom: spacing.md,
        }}
      >
        <Text style={{ fontSize: 20 }}>📋</Text>
        <ThemedText
          variant="titleSmall"
          weight="bold"
          style={{ flex: 1, color: theme.colors.planModeLight }}
        >
          {title}
        </ThemedText>
      </View>

      {/* Action Buttons */}
      <View
        style={{
          flexDirection: "row",
          gap: spacing.sm,
          marginBottom: spacing.md,
          flexWrap: "wrap",
        }}
      >
        <Pressable onPress={handleCopy} style={buttonStyle(copied)}>
          <ThemedText
            variant="caption"
            weight="medium"
            style={{ color: theme.colors.planModeLight }}
          >
            {copied ? "✓ Copied" : "Copy"}
          </ThemedText>
        </Pressable>
        <Pressable onPress={() => setShowRaw(!showRaw)} style={buttonStyle(showRaw)}>
          <ThemedText
            variant="caption"
            weight="medium"
            style={{ color: theme.colors.planModeLight }}
          >
            {showRaw ? "Show Markdown" : "Show Text"}
          </ThemedText>
        </Pressable>
        {workspaceId && onStartHere && (
          <Pressable onPress={() => setShowModal(true)} style={buttonStyle(false)}>
            <ThemedText
              variant="caption"
              weight="medium"
              style={{ color: theme.colors.planModeLight }}
            >
              Start Here
            </ThemedText>
          </Pressable>
        )}
      </View>

      {/* Plan Content */}
      <View
        style={{
          maxHeight: 400,
          borderRadius: theme.radii.sm,
          backgroundColor: theme.colors.surfaceSunken,
          padding: spacing.sm,
        }}
      >
        {showRaw ? (
          <ScrollView showsVerticalScrollIndicator>
            <Text
              style={{
                fontFamily: theme.typography.familyMono,
                fontSize: 12,
                color: theme.colors.foregroundPrimary,
                lineHeight: 18,
              }}
            >
              {plan}
            </Text>
          </ScrollView>
        ) : (
          <ScrollView showsVerticalScrollIndicator>
            <MarkdownMessageBody variant="plan" content={plan} styleOverrides={markdownOverrides} />
          </ScrollView>
        )}
      </View>

      {/* Footer hint (when completed) */}
      {status === "completed" && (
        <ThemedText
          variant="caption"
          style={{
            marginTop: spacing.md,
            fontStyle: "italic",
            color: theme.colors.foregroundSecondary,
          }}
        >
          💡 Respond with revisions or ask to implement in Exec mode
        </ThemedText>
      )}

      <StartHereModal
        visible={showModal}
        onConfirm={handleStartHere}
        onCancel={() => setShowModal(false)}
        isExecuting={isStartingHere}
      />
    </Surface>
  );
}
