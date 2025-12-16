import assert from "@/common/utils/assert";

import { useEffect, useMemo, useState } from "react";

import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { useAPI } from "@/browser/contexts/API";
import { Checkbox } from "@/browser/components/ui/checkbox";
import { Input } from "@/browser/components/ui/input";
import { Button } from "@/browser/components/ui/button";
import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolName,
} from "@/browser/components/tools/shared/ToolPrimitives";
import {
  getStatusDisplay,
  useToolExpansion,
  type ToolStatus,
} from "@/browser/components/tools/shared/toolUtils";
import type {
  AskUserQuestionQuestion,
  AskUserQuestionToolArgs,
  AskUserQuestionToolResult,
  AskUserQuestionToolSuccessResult,
  ToolErrorResult,
} from "@/common/types/tools";

const OTHER_VALUE = "__other__";

interface DraftAnswer {
  selected: string[];
  otherText: string;
}

interface CachedState {
  draftAnswers: Record<string, DraftAnswer>;
  activeIndex: number;
}

// Cache draft state by toolCallId so it survives workspace switches
const draftStateCache = new Map<string, CachedState>();

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

function isToolErrorResult(val: unknown): val is ToolErrorResult {
  if (!val || typeof val !== "object") {
    return false;
  }

  const record = val as Record<string, unknown>;
  return record.success === false && typeof record.error === "string";
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
  assert(isQuestionAnswered(question, draft), "draftToAnswerString requires a complete answer");

  const parts: string[] = [];
  for (const label of draft.selected) {
    if (label === OTHER_VALUE) {
      parts.push(draft.otherText.trim());
    } else {
      parts.push(label);
    }
  }

  if (!question.multiSelect) {
    assert(parts.length === 1, "Single-select questions must have exactly one answer");
    return parts[0];
  }

  return parts.join(", ");
}

/**
 * Get descriptions for selected answer labels from a question's options.
 * Filters out "Other" and labels not found in options.
 */
function getDescriptionsForLabels(question: AskUserQuestionQuestion, labels: string[]): string[] {
  return labels
    .filter((label) => label !== OTHER_VALUE)
    .map((label) => question.options.find((o) => o.label === label)?.description)
    .filter((d): d is string => d !== undefined);
}

export function AskUserQuestionToolCall(props: {
  args: AskUserQuestionToolArgs;
  result: AskUserQuestionToolResult | null;
  status: ToolStatus;
  toolCallId: string;
  workspaceId?: string;
}): JSX.Element {
  const { api } = useAPI();

  const { expanded, toggleExpanded } = useToolExpansion(props.status === "executing");
  const statusDisplay = getStatusDisplay(props.status);

  const argsAnswers = props.args.answers ?? {};

  // Restore from cache if available (survives workspace switches)
  const cachedState = draftStateCache.get(props.toolCallId);

  const [activeIndex, setActiveIndex] = useState(() => cachedState?.activeIndex ?? 0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [draftAnswers, setDraftAnswers] = useState<Record<string, DraftAnswer>>(() => {
    if (cachedState) {
      return cachedState.draftAnswers;
    }

    const initial: Record<string, DraftAnswer> = {};
    for (const q of props.args.questions) {
      const prefilled = argsAnswers[q.question];
      if (typeof prefilled === "string") {
        initial[q.question] = parsePrefilledAnswer(q, prefilled);
      } else {
        initial[q.question] = { selected: [], otherText: "" };
      }
    }
    return initial;
  });

  // Sync draft state to cache so it survives workspace switches
  useEffect(() => {
    if (props.status === "executing") {
      draftStateCache.set(props.toolCallId, { draftAnswers, activeIndex });
    } else {
      // Clean up cache when tool completes
      draftStateCache.delete(props.toolCallId);
    }
  }, [props.toolCallId, props.status, draftAnswers, activeIndex]);

  const resultUnwrapped = useMemo(() => {
    if (!props.result) {
      return null;
    }

    return unwrapJsonContainer(props.result);
  }, [props.result]);

  const successResult =
    resultUnwrapped && isAskUserQuestionToolSuccessResult(resultUnwrapped) ? resultUnwrapped : null;

  const errorResult =
    resultUnwrapped && isToolErrorResult(resultUnwrapped) ? resultUnwrapped : null;

  const isComplete = useMemo(() => {
    return props.args.questions.every((q) => {
      const draft = draftAnswers[q.question];
      return draft ? isQuestionAnswered(q, draft) : false;
    });
  }, [draftAnswers, props.args.questions]);

  const summaryIndex = props.args.questions.length;
  const isOnSummary = activeIndex === summaryIndex;
  const currentQuestion = isOnSummary
    ? null
    : props.args.questions[Math.min(activeIndex, props.args.questions.length - 1)];
  const currentDraft = currentQuestion ? draftAnswers[currentQuestion.question] : undefined;

  const unansweredCount = useMemo(() => {
    return props.args.questions.filter((q) => {
      const draft = draftAnswers[q.question];
      return !draft || !isQuestionAnswered(q, draft);
    }).length;
  }, [draftAnswers, props.args.questions]);

  const handleSubmit = (): void => {
    setIsSubmitting(true);
    setSubmitError(null);

    let answers: Record<string, string>;
    let workspaceId: string;

    try {
      answers = {};
      for (const q of props.args.questions) {
        const draft = draftAnswers[q.question];
        if (draft && isQuestionAnswered(q, draft)) {
          answers[q.question] = draftToAnswerString(q, draft);
        } else {
          // Unanswered questions get empty string
          answers[q.question] = "";
        }
      }

      assert(api, "API not connected");
      assert(props.workspaceId, "workspaceId is required");
      workspaceId = props.workspaceId;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setSubmitError(errorMessage);
      setIsSubmitting(false);
      return;
    }

    api.workspace
      .answerAskUserQuestion({
        workspaceId,
        toolCallId: props.toolCallId,
        answers,
      })
      .then((result) => {
        if (!result.success) {
          setSubmitError(result.error);
          return;
        }

        // If the stream was interrupted (e.g. app restart) we need to explicitly
        // kick the resume manager so the assistant continues after answers.
        window.dispatchEvent(
          createCustomEvent(CUSTOM_EVENTS.RESUME_CHECK_REQUESTED, {
            workspaceId,
            isManual: true,
          })
        );
      })
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setSubmitError(errorMessage);
      })
      .finally(() => {
        setIsSubmitting(false);
      });
  };
  const title = "ask_user_question";

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <div className="flex flex-1 flex-col">
          <ToolName>{title}</ToolName>
          <div className="text-muted-foreground text-xs">
            Answer below, or type in chat to cancel.
          </div>
        </div>
        <StatusIndicator status={props.status}>{statusDisplay}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          <div className="flex flex-col gap-4">
            {props.status === "executing" && (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap gap-2">
                  {props.args.questions.map((q, idx) => {
                    const draft = draftAnswers[q.question];
                    const answered = draft ? isQuestionAnswered(q, draft) : false;
                    const isActive = idx === activeIndex;
                    return (
                      <button
                        key={q.question}
                        type="button"
                        className={
                          "text-xs px-2 py-1 rounded border " +
                          (isActive
                            ? "bg-primary text-primary-foreground border-primary"
                            : answered
                              ? "bg-green-900/30 text-green-400 border-green-700"
                              : "bg-muted text-foreground border-border")
                        }
                        onClick={() => setActiveIndex(idx)}
                      >
                        {q.header}
                        {answered ? " ✓" : ""}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={
                      "text-xs px-2 py-1 rounded border " +
                      (isOnSummary
                        ? "bg-primary text-primary-foreground border-primary"
                        : isComplete
                          ? "bg-green-900/30 text-green-400 border-green-700"
                          : "bg-muted text-foreground border-border")
                    }
                    onClick={() => setActiveIndex(summaryIndex)}
                  >
                    Summary{isComplete ? " ✓" : ""}
                  </button>
                </div>

                {!isOnSummary && currentQuestion && currentDraft && (
                  <>
                    <div>
                      <div className="text-sm font-medium">{currentQuestion.question}</div>
                      <div className="text-muted-foreground text-xs">
                        {currentQuestion.multiSelect
                          ? "Select one or more options"
                          : "Select one option"}
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      {/* Render option checkboxes */}
                      {[
                        ...currentQuestion.options.map((opt) => ({
                          label: opt.label,
                          displayLabel: opt.label,
                          description: opt.description,
                        })),
                        {
                          label: OTHER_VALUE,
                          displayLabel: "Other",
                          description: "Provide a custom answer.",
                        },
                      ].map((opt) => {
                        const checked = currentDraft.selected.includes(opt.label);

                        const toggle = () => {
                          const isSelecting = !checked;

                          setDraftAnswers((prev) => {
                            const draft = prev[currentQuestion.question] ?? {
                              selected: [],
                              otherText: "",
                            };

                            if (currentQuestion.multiSelect) {
                              // Multi-select: toggle this option
                              const selected = new Set(draft.selected);
                              if (selected.has(opt.label)) {
                                selected.delete(opt.label);
                              } else {
                                selected.add(opt.label);
                              }
                              return {
                                ...prev,
                                [currentQuestion.question]: {
                                  ...draft,
                                  selected: Array.from(selected),
                                },
                              };
                            } else {
                              // Single-select: replace selection (clear otherText if not Other)
                              return {
                                ...prev,
                                [currentQuestion.question]: {
                                  selected: checked ? [] : [opt.label],
                                  otherText: opt.label === OTHER_VALUE ? draft.otherText : "",
                                },
                              };
                            }
                          });

                          // For single-select questions, auto-advance *only* when the user selects
                          // a non-Other option (avoid useEffect auto-advance that breaks back-nav).
                          if (
                            !currentQuestion.multiSelect &&
                            isSelecting &&
                            opt.label !== OTHER_VALUE
                          ) {
                            setActiveIndex((idx) => idx + 1);
                          }
                        };

                        return (
                          <div
                            key={opt.label}
                            role="button"
                            tabIndex={0}
                            className="flex cursor-pointer items-start gap-2 select-none"
                            onClick={toggle}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggle();
                              }
                            }}
                          >
                            <Checkbox
                              checked={checked}
                              onCheckedChange={toggle}
                              onClick={(e) => e.stopPropagation()}
                            />
                            <div className="flex flex-col">
                              <div className="text-sm">{opt.displayLabel}</div>
                              <div className="text-muted-foreground text-xs">{opt.description}</div>
                            </div>
                          </div>
                        );
                      })}

                      {currentDraft.selected.includes(OTHER_VALUE) && (
                        <Input
                          placeholder="Type your answer"
                          value={currentDraft.otherText}
                          onChange={(e) => {
                            const value = e.target.value;
                            setDraftAnswers((prev) => ({
                              ...prev,
                              [currentQuestion.question]: {
                                ...(prev[currentQuestion.question] ?? {
                                  selected: [],
                                  otherText: "",
                                }),
                                otherText: value,
                              },
                            }));
                          }}
                        />
                      )}
                    </div>
                  </>
                )}

                {isOnSummary && (
                  <div className="flex flex-col gap-2">
                    <div className="text-sm font-medium">Review your answers</div>
                    {unansweredCount > 0 && (
                      <div className="text-xs text-yellow-500">
                        ⚠️ {unansweredCount} question{unansweredCount > 1 ? "s" : ""} not answered
                      </div>
                    )}
                    <div className="flex flex-col gap-2">
                      {props.args.questions.map((q, idx) => {
                        const draft = draftAnswers[q.question];
                        const answered = draft ? isQuestionAnswered(q, draft) : false;
                        const answerText = answered ? draftToAnswerString(q, draft) : null;
                        const descriptions = answered
                          ? getDescriptionsForLabels(q, draft.selected)
                          : [];
                        return (
                          <div
                            key={q.question}
                            role="button"
                            tabIndex={0}
                            className="hover:bg-muted/50 -ml-2 cursor-pointer rounded px-2 py-1"
                            onClick={() => setActiveIndex(idx)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                setActiveIndex(idx);
                              }
                            }}
                          >
                            <div className="flex items-start gap-1">
                              {answered ? (
                                <span className="text-green-400">✓</span>
                              ) : (
                                <span className="text-yellow-500">⚠️</span>
                              )}{" "}
                              <div className="flex flex-col">
                                <div>
                                  <span className="font-medium">{q.header}:</span>{" "}
                                  {answered ? (
                                    <span className="text-muted-foreground">{answerText}</span>
                                  ) : (
                                    <span className="text-muted-foreground italic">
                                      Not answered
                                    </span>
                                  )}
                                </div>
                                {descriptions.length > 0 && (
                                  <div className="text-muted-foreground ml-1 text-xs italic">
                                    {descriptions.join("; ")}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="text-muted-foreground text-xs">
                  Tip: you can also just type a message to respond in chat (this will cancel these
                  questions).
                </div>

                {submitError && <ErrorBox>{submitError}</ErrorBox>}
              </div>
            )}

            {props.status !== "executing" && (
              <div className="flex flex-col gap-2">
                {successResult && (
                  <div className="text-muted-foreground flex flex-col gap-2 text-sm">
                    <div>User answered:</div>
                    {Object.entries(successResult.answers).map(([question, answer]) => {
                      const questionDef = successResult.questions.find(
                        (q) => q.question === question
                      );
                      // Parse answer labels (could be comma-separated for multi-select)
                      const answerLabels = answer.split(",").map((s) => s.trim());
                      const descriptions = questionDef
                        ? getDescriptionsForLabels(questionDef, answerLabels)
                        : [];

                      return (
                        <div key={question} className="ml-4 flex flex-col">
                          <div>
                            • <span className="font-medium">{question}:</span> {answer}
                          </div>
                          {descriptions.length > 0 && (
                            <div className="text-muted-foreground ml-3 text-xs italic">
                              {descriptions.join("; ")}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {errorResult && <ErrorBox>{errorResult.error}</ErrorBox>}
              </div>
            )}

            {props.status === "executing" && (
              <div className="flex justify-end">
                {isOnSummary ? (
                  <Button disabled={isSubmitting} onClick={handleSubmit}>
                    {isSubmitting ? "Submitting…" : "Submit answers"}
                  </Button>
                ) : (
                  <Button onClick={() => setActiveIndex(activeIndex + 1)}>Next</Button>
                )}
              </div>
            )}
          </div>
        </ToolDetails>
      )}
    </ToolContainer>
  );
}
