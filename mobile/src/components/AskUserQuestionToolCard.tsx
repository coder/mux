import type { JSX } from "react";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import type {
  AskUserQuestionQuestion,
  AskUserQuestionToolArgs,
  AskUserQuestionToolResult,
  AskUserQuestionToolSuccessResult,
  ToolErrorResult,
} from "@/common/types/tools";
import { Surface } from "./Surface";
import { ThemedText } from "./ThemedText";
import { useTheme } from "../theme";
import { useORPC } from "../orpc/react";

type ToolStatus = "pending" | "executing" | "completed" | "failed" | "interrupted";

const OTHER_VALUE = "__other__";

type DraftAnswer = {
  selected: string[];
  otherText: string;
};

// Cache draft answers by toolCallId so drafts survive list virtualization/workspace switches
const draftStateCache = new Map<string, Record<string, DraftAnswer>>();

function unwrapJsonContainer(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.type === "json" && "value" in record) {
    return record.value;
  }

  return value;
}

function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
}

function isAskUserQuestionToolSuccessResult(val: unknown): val is AskUserQuestionToolSuccessResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return false;
  }

  if (!record.answers || typeof record.answers !== "object") {
    return false;
  }

  for (const [, v] of Object.entries(record.answers as Record<string, unknown>)) {
    if (typeof v !== "string") {
      return false;
    }
  }

  return true;
}

function isAskUserQuestionToolArgs(val: unknown): val is AskUserQuestionToolArgs {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  if (!Array.isArray(record.questions)) {
    return false;
  }

  return record.questions.every((q) => {
    if (!q || typeof q !== "object") {
      return false;
    }

    const question = q as Record<string, unknown>;
    if (typeof question.question !== "string") {
      return false;
    }

    if (typeof question.header !== "string") {
      return false;
    }

    if (!Array.isArray(question.options)) {
      return false;
    }

    if (typeof question.multiSelect !== "boolean") {
      return false;
    }

    return question.options.every((opt) => {
      if (!opt || typeof opt !== "object") {
        return false;
      }
      const option = opt as Record<string, unknown>;
      return typeof option.label === "string" && typeof option.description === "string";
    });
  });
}

function parsePrefilledAnswer(question: AskUserQuestionQuestion, answer: string): DraftAnswer {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return { selected: [], otherText: "" };
  }

  const optionLabels = new Set(question.options.map((o) => o.label));

  if (!question.multiSelect) {
    if (optionLabels.has(trimmed)) {
      return { selected: [trimmed], otherText: "" };
    }

    return { selected: [OTHER_VALUE], otherText: trimmed };
  }

  const tokens = trimmed
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const selected: string[] = [];
  const otherParts: string[] = [];

  for (const token of tokens) {
    if (optionLabels.has(token)) {
      selected.push(token);
    } else {
      otherParts.push(token);
    }
  }

  if (otherParts.length > 0) {
    selected.push(OTHER_VALUE);
  }

  return { selected, otherText: otherParts.join(", ") };
}

function isQuestionAnswered(question: AskUserQuestionQuestion, draft: DraftAnswer): boolean {
  if (draft.selected.length === 0) {
    return false;
  }

  if (draft.selected.includes(OTHER_VALUE)) {
    return draft.otherText.trim().length > 0;
  }

  return true;
}

function draftToAnswerString(question: AskUserQuestionQuestion, draft: DraftAnswer): string {
  const parts: string[] = [];
  for (const label of draft.selected) {
    if (label === OTHER_VALUE) {
      parts.push(draft.otherText.trim());
    } else {
      parts.push(label);
    }
  }

  if (!question.multiSelect) {
    return parts[0] ?? "";
  }

  return parts.join(", ");
}

export function AskUserQuestionToolCard(props: {
  args: unknown;
  result: unknown;
  status: ToolStatus;
  toolCallId: string;
  workspaceId?: string;
}): JSX.Element {
  const theme = useTheme();
  const spacing = theme.spacing;
  const client = useORPC();

  const parsedArgs = useMemo(
    () => (isAskUserQuestionToolArgs(props.args) ? props.args : null),
    [props.args]
  );

  const resultUnwrapped = useMemo(() => unwrapJsonContainer(props.result), [props.result]);

  const successResult: AskUserQuestionToolSuccessResult | null =
    resultUnwrapped && isAskUserQuestionToolSuccessResult(resultUnwrapped) ? resultUnwrapped : null;

  const errorResult: ToolErrorResult | null =
    resultUnwrapped && isToolErrorResult(resultUnwrapped) ? resultUnwrapped : null;

  const argsAnswers = parsedArgs?.answers ?? {};

  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftAnswer>>(() => {
    const cached = draftStateCache.get(props.toolCallId);
    if (cached) {
      return cached;
    }

    const initial: Record<string, DraftAnswer> = {};
    if (!parsedArgs) {
      return initial;
    }

    for (const q of parsedArgs.questions) {
      const prefilled = argsAnswers[q.question];
      if (typeof prefilled === "string") {
        initial[q.question] = parsePrefilledAnswer(q, prefilled);
      } else {
        initial[q.question] = { selected: [], otherText: "" };
      }
    }

    return initial;
  });

  useEffect(() => {
    if (props.status === "executing") {
      draftStateCache.set(props.toolCallId, draftAnswers);
    } else {
      draftStateCache.delete(props.toolCallId);
    }
  }, [props.status, props.toolCallId, draftAnswers]);

  const isComplete = useMemo(() => {
    if (!parsedArgs) {
      return false;
    }

    return parsedArgs.questions.every((q) => {
      const draft = draftAnswers[q.question];
      return draft ? isQuestionAnswered(q, draft) : false;
    });
  }, [parsedArgs, draftAnswers]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (successResult) {
      setSubmitted(true);
      setSubmitError(null);
    }
  }, [successResult]);

  const statusLabel = (() => {
    switch (props.status) {
      case "completed":
        return "✓ Completed";
      case "failed":
        return "✗ Failed";
      case "interrupted":
        return "⚠ Interrupted";
      case "executing":
        return "⟳ Executing";
      default:
        return "○ Pending";
    }
  })();

  const toggleSelection = (question: AskUserQuestionQuestion, label: string) => {
    setDraftAnswers((current) => {
      const next = { ...current };
      const draft = next[question.question] ?? { selected: [], otherText: "" };

      if (!question.multiSelect) {
        next[question.question] = {
          selected: [label],
          otherText: label === OTHER_VALUE ? draft.otherText : "",
        };
        return next;
      }

      const selectedSet = new Set(draft.selected);
      if (selectedSet.has(label)) {
        selectedSet.delete(label);
      } else {
        selectedSet.add(label);
      }

      const selected = Array.from(selectedSet);
      const otherText = selected.includes(OTHER_VALUE) ? draft.otherText : "";
      next[question.question] = { selected, otherText };
      return next;
    });
  };

  const updateOtherText = (questionText: string, text: string) => {
    setDraftAnswers((current) => {
      const draft = current[questionText] ?? { selected: [OTHER_VALUE], otherText: "" };
      return {
        ...current,
        [questionText]: {
          ...draft,
          selected: draft.selected.includes(OTHER_VALUE)
            ? draft.selected
            : [...draft.selected, OTHER_VALUE],
          otherText: text,
        },
      };
    });
  };

  const handleSubmit = async () => {
    if (!parsedArgs) {
      return;
    }

    if (!props.workspaceId) {
      setSubmitError("Missing workspaceId");
      return;
    }

    if (!isComplete) {
      setSubmitError("Please answer all questions");
      return;
    }

    if (isSubmitting || submitted) {
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const answers: Record<string, string> = {};
      for (const q of parsedArgs.questions) {
        const draft = draftAnswers[q.question];
        if (!draft) {
          continue;
        }
        answers[q.question] = draftToAnswerString(q, draft);
      }

      const result = await client.workspace.answerAskUserQuestion({
        workspaceId: props.workspaceId,
        toolCallId: props.toolCallId,
        answers,
      });

      if (!result.success) {
        setSubmitError(result.error ?? "Failed to submit answers");
        return;
      }

      setSubmitted(true);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!parsedArgs) {
    return (
      <Surface variant="plain" style={{ padding: spacing.md, marginBottom: spacing.md }}>
        <ThemedText weight="semibold">ask_user_question</ThemedText>
        <ThemedText variant="caption" style={{ marginTop: spacing.sm }}>
          (Unsupported args)
        </ThemedText>
      </Surface>
    );
  }

  return (
    <Surface variant="plain" style={{ padding: spacing.md, marginBottom: spacing.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text style={{ fontSize: 16 }}>❓</Text>
        <ThemedText variant="label" style={{ flex: 1 }}>
          ask_user_question ({parsedArgs.questions.length})
        </ThemedText>
        <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
          {statusLabel}
        </ThemedText>
      </View>

      {errorResult ? (
        <View style={{ marginTop: spacing.sm }}>
          <ThemedText variant="mono" style={{ color: theme.colors.danger }}>
            {errorResult.error}
          </ThemedText>
        </View>
      ) : null}

      {successResult ? (
        <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
          {parsedArgs.questions.map((q) => (
            <View key={q.question} style={{ gap: 4 }}>
              <ThemedText weight="semibold">{q.header}</ThemedText>
              <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
                {successResult.answers[q.question]}
              </ThemedText>
            </View>
          ))}
        </View>
      ) : (
        <View style={{ marginTop: spacing.md, gap: spacing.lg }}>
          {parsedArgs.questions.map((q) => {
            const draft = draftAnswers[q.question] ?? { selected: [], otherText: "" };
            const answered = isQuestionAnswered(q, draft);

            return (
              <View key={q.question} style={{ gap: spacing.sm }}>
                <View style={{ gap: 2 }}>
                  <ThemedText weight="semibold">{q.header}</ThemedText>
                  <ThemedText variant="caption" style={{ color: theme.colors.foregroundSecondary }}>
                    {q.question}
                  </ThemedText>
                </View>

                <View style={{ gap: spacing.xs }}>
                  {q.options.map((opt) => {
                    const selected = draft.selected.includes(opt.label);
                    const indicator = q.multiSelect ? (selected ? "☑" : "☐") : selected ? "◉" : "○";

                    return (
                      <Pressable
                        key={opt.label}
                        onPress={() => toggleSelection(q, opt.label)}
                        disabled={submitted || props.status !== "executing"}
                        style={({ pressed }) => ({
                          flexDirection: "row",
                          gap: spacing.sm,
                          paddingVertical: spacing.xs,
                          paddingHorizontal: spacing.sm,
                          borderRadius: theme.radii.sm,
                          backgroundColor: pressed
                            ? theme.colors.surfaceSecondary
                            : theme.colors.surfaceSunken,
                          opacity: submitted || props.status !== "executing" ? 0.6 : 1,
                        })}
                      >
                        <Text style={{ width: 20 }}>{indicator}</Text>
                        <View style={{ flex: 1, gap: 2 }}>
                          <ThemedText weight="semibold">{opt.label}</ThemedText>
                          <ThemedText
                            variant="caption"
                            style={{ color: theme.colors.foregroundSecondary }}
                          >
                            {opt.description}
                          </ThemedText>
                        </View>
                      </Pressable>
                    );
                  })}

                  {/* Implicit Other option */}
                  {(() => {
                    const selected = draft.selected.includes(OTHER_VALUE);
                    const indicator = q.multiSelect ? (selected ? "☑" : "☐") : selected ? "◉" : "○";

                    return (
                      <View style={{ gap: spacing.xs }}>
                        <Pressable
                          onPress={() => toggleSelection(q, OTHER_VALUE)}
                          disabled={submitted || props.status !== "executing"}
                          style={({ pressed }) => ({
                            flexDirection: "row",
                            gap: spacing.sm,
                            paddingVertical: spacing.xs,
                            paddingHorizontal: spacing.sm,
                            borderRadius: theme.radii.sm,
                            backgroundColor: pressed
                              ? theme.colors.surfaceSecondary
                              : theme.colors.surfaceSunken,
                            opacity: submitted || props.status !== "executing" ? 0.6 : 1,
                          })}
                        >
                          <Text style={{ width: 20 }}>{indicator}</Text>
                          <View style={{ flex: 1, gap: 2 }}>
                            <ThemedText weight="semibold">Other</ThemedText>
                            <ThemedText
                              variant="caption"
                              style={{ color: theme.colors.foregroundSecondary }}
                            >
                              Provide your own answer
                            </ThemedText>
                          </View>
                        </Pressable>

                        {selected ? (
                          <TextInput
                            value={draft.otherText}
                            onChangeText={(text) => updateOtherText(q.question, text)}
                            editable={!submitted && props.status === "executing"}
                            placeholder="Type your answer"
                            placeholderTextColor={theme.colors.foregroundMuted}
                            style={{
                              borderWidth: 1,
                              borderColor: answered ? theme.colors.border : theme.colors.warning,
                              borderRadius: theme.radii.sm,
                              backgroundColor: theme.colors.surface,
                              color: theme.colors.foregroundPrimary,
                              paddingHorizontal: spacing.sm,
                              paddingVertical: spacing.xs,
                              fontSize: 14,
                            }}
                          />
                        ) : null}
                      </View>
                    );
                  })()}
                </View>
              </View>
            );
          })}

          {submitError ? (
            <ThemedText variant="mono" style={{ color: theme.colors.danger }}>
              {submitError}
            </ThemedText>
          ) : null}

          <Pressable
            onPress={handleSubmit}
            disabled={!isComplete || submitted || props.status !== "executing" || isSubmitting}
            style={({ pressed }) => ({
              marginTop: spacing.sm,
              paddingVertical: spacing.sm,
              paddingHorizontal: spacing.md,
              borderRadius: theme.radii.sm,
              alignItems: "center",
              backgroundColor:
                submitted || props.status !== "executing" || !isComplete
                  ? theme.colors.inputBorder
                  : pressed
                    ? theme.colors.accentHover
                    : theme.colors.accent,
            })}
          >
            <ThemedText
              weight="semibold"
              style={{
                color:
                  submitted || props.status !== "executing" || !isComplete
                    ? theme.colors.foregroundMuted
                    : theme.colors.foregroundInverted,
              }}
            >
              {submitted ? "Submitted" : isSubmitting ? "Submitting…" : "Submit answers"}
            </ThemedText>
          </Pressable>
        </View>
      )}
    </Surface>
  );
}
