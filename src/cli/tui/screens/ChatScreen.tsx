import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  isCaughtUpMessage,
  isMuxMessage,
  isReasoningDelta,
  isReasoningEnd,
  isStreamAbort,
  isStreamDelta,
  isStreamEnd,
  isStreamError,
  isStreamStart,
  isToolCallDelta,
  isToolCallEnd,
  isToolCallStart,
} from "@/common/orpc/types";
import type {
  APIClient,
  TuiAction,
  TuiOptions,
  TuiState,
  TuiWorkspaceChatMessage,
} from "@/cli/tui/tuiTypes";

interface ChatScreenProps {
  api: APIClient;
  state: TuiState;
  dispatch: React.Dispatch<TuiAction>;
  workspaceId: string;
  options: TuiOptions;
}

interface AskQuestionOption {
  label: string;
  description: string;
}

interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

interface PendingAskUserQuestion {
  toolCallId: string;
  questions: AskQuestion[];
  answers: Record<string, string>;
  activeIndex: number;
}

const MESSAGE_VIEWPORT_SIZE = 12;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function unwrapJsonContainer(value: unknown): unknown {
  const record = asRecord(value);
  if (record?.type !== "json") {
    return value;
  }

  return record.value;
}

function parseAskUserQuestions(args: unknown): AskQuestion[] | null {
  const rawArgs = unwrapJsonContainer(args);
  const argsRecord = asRecord(rawArgs);
  if (!argsRecord || !Array.isArray(argsRecord.questions)) {
    return null;
  }

  const parsed: AskQuestion[] = [];
  for (const [index, questionEntry] of argsRecord.questions.entries()) {
    const questionRecord = asRecord(questionEntry);
    if (!questionRecord || typeof questionRecord.question !== "string") {
      continue;
    }

    const options: AskQuestionOption[] = [];
    if (Array.isArray(questionRecord.options)) {
      for (const optionEntry of questionRecord.options) {
        const optionRecord = asRecord(optionEntry);
        if (!optionRecord || typeof optionRecord.label !== "string") {
          continue;
        }

        options.push({
          label: optionRecord.label,
          description:
            typeof optionRecord.description === "string"
              ? optionRecord.description
              : optionRecord.label,
        });
      }
    }

    parsed.push({
      question: questionRecord.question,
      header:
        typeof questionRecord.header === "string" && questionRecord.header.trim().length > 0
          ? questionRecord.header
          : `Question ${index + 1}`,
      options,
      multiSelect: questionRecord.multiSelect === true,
    });
  }

  return parsed.length > 0 ? parsed : null;
}

function extractMessageText(event: TuiWorkspaceChatMessage): string {
  const contentRecord = event as { content?: unknown };
  if (typeof contentRecord.content === "string") {
    return contentRecord.content;
  }

  const partsRecord = event as { parts?: unknown };
  if (!Array.isArray(partsRecord.parts)) {
    return "";
  }

  const textParts: string[] = [];
  for (const part of partsRecord.parts) {
    const partRecord = asRecord(part);
    if (partRecord?.type !== "text") {
      continue;
    }

    if (typeof partRecord.text !== "string") {
      continue;
    }

    textParts.push(partRecord.text);
  }

  return textParts.join("");
}

function normalizeQuestionAnswer(rawAnswer: string, question: AskQuestion): string {
  const trimmed = rawAnswer.trim();
  if (!trimmed || question.options.length === 0) {
    return trimmed;
  }

  const selectionTokens = trimmed
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  if (selectionTokens.length === 0) {
    return trimmed;
  }

  const selectedLabels: string[] = [];
  for (const token of selectionTokens) {
    const index = Number(token);
    if (!Number.isInteger(index) || index < 1 || index > question.options.length) {
      return trimmed;
    }

    selectedLabels.push(question.options[index - 1].label);
    if (!question.multiSelect) {
      break;
    }
  }

  if (selectedLabels.length === 0) {
    return trimmed;
  }

  return question.multiSelect ? selectedLabels.join(", ") : selectedLabels[0];
}

function formatSendMessageError(error: unknown): string {
  const record = asRecord(error);
  if (!record) {
    return toErrorMessage(error);
  }

  const type = typeof record.type === "string" ? record.type : "send_error";
  const message = typeof record.message === "string" ? record.message : null;
  const provider = typeof record.provider === "string" ? record.provider : null;

  if (message) {
    return `${type}: ${message}`;
  }

  if (provider) {
    return `${type} (${provider})`;
  }

  return type;
}

export function ChatScreen(props: ChatScreenProps) {
  const [inputValue, setInputValue] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [isInterrupting, setIsInterrupting] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<PendingAskUserQuestion | null>(null);
  const [isAnsweringQuestion, setIsAnsweringQuestion] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);
  const api = props.api;
  const dispatch = props.dispatch;
  const workspaceId = props.workspaceId;
  const options = props.options;

  useEffect(() => {
    let cancelled = false;
    let iterator:
      | (AsyncIterable<TuiWorkspaceChatMessage> & AsyncIterator<TuiWorkspaceChatMessage>)
      | null = null;

    dispatch({ type: "CHAT_RESET" });
    dispatch({ type: "SET_ERROR", error: null });
    setPendingQuestion(null);
    setQuestionError(null);
    setInputValue("");

    const subscribeToChat = async (): Promise<void> => {
      iterator = await api.workspace.onChat({ workspaceId });

      for await (const event of iterator) {
        if (cancelled) {
          break;
        }

        if (isCaughtUpMessage(event)) {
          dispatch({ type: "CHAT_CAUGHT_UP" });
          continue;
        }

        if (isStreamStart(event)) {
          dispatch({ type: "CHAT_STREAM_START" });
          continue;
        }

        if (isStreamDelta(event)) {
          dispatch({ type: "CHAT_STREAM_DELTA", delta: event.delta });
          continue;
        }

        if (isStreamEnd(event)) {
          dispatch({ type: "CHAT_STREAM_END" });
          continue;
        }

        if (isStreamAbort(event)) {
          dispatch({ type: "CHAT_STREAM_ABORT" });
          continue;
        }

        if (isStreamError(event)) {
          dispatch({ type: "SET_ERROR", error: event.error });
          continue;
        }

        if (isToolCallStart(event)) {
          dispatch({
            type: "CHAT_TOOL_CALL_START",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
          });

          if (event.toolName === "ask_user_question") {
            const parsedQuestions = parseAskUserQuestions(event.args);
            if (parsedQuestions) {
              setPendingQuestion({
                toolCallId: event.toolCallId,
                questions: parsedQuestions,
                answers: {},
                activeIndex: 0,
              });
              setQuestionError(null);
              setInputValue("");
            }
          }
          continue;
        }

        if (isToolCallDelta(event)) {
          if (event.toolName === "ask_user_question") {
            const parsedQuestions = parseAskUserQuestions(event.delta);
            if (parsedQuestions && parsedQuestions.length > 0) {
              setPendingQuestion((current) => {
                if (!current || current.toolCallId !== event.toolCallId) {
                  return {
                    toolCallId: event.toolCallId,
                    questions: parsedQuestions,
                    answers: {},
                    activeIndex: 0,
                  };
                }

                return {
                  ...current,
                  questions: parsedQuestions,
                };
              });
            }
          }
          continue;
        }

        if (isToolCallEnd(event)) {
          dispatch({
            type: "CHAT_TOOL_CALL_END",
            toolCallId: event.toolCallId,
          });
          setPendingQuestion((current) =>
            current && current.toolCallId === event.toolCallId ? null : current
          );
          continue;
        }

        if (isReasoningDelta(event) || isReasoningEnd(event)) {
          continue;
        }

        if (isMuxMessage(event) && (event.role === "user" || event.role === "assistant")) {
          dispatch({
            type: "CHAT_ADD_MESSAGE",
            message: {
              role: event.role,
              content: extractMessageText(event),
            },
          });
        }
      }
    };

    subscribeToChat().catch((error: unknown) => {
      if (cancelled) {
        return;
      }

      dispatch({
        type: "SET_ERROR",
        error: `Chat subscription failed: ${toErrorMessage(error)}`,
      });
    });

    return () => {
      cancelled = true;
      if (iterator && typeof iterator.return === "function") {
        Promise.resolve(iterator.return()).catch(() => {
          // Best effort close while unmounting.
        });
      }
    };
  }, [api, dispatch, workspaceId]);

  const sendMessage = async (messageText: string): Promise<void> => {
    dispatch({ type: "SET_ERROR", error: null });
    dispatch({
      type: "CHAT_ADD_MESSAGE",
      message: { role: "user", content: messageText },
    });

    setIsSending(true);
    try {
      const result = await api.workspace.sendMessage({
        workspaceId: workspaceId,
        message: messageText,
        options: {
          model: options.model,
          agentId: options.agentId,
        },
      });

      if (!result.success) {
        dispatch({
          type: "SET_ERROR",
          error: `Failed to send message: ${formatSendMessageError(result.error)}`,
        });
      }
    } catch (error: unknown) {
      dispatch({
        type: "SET_ERROR",
        error: `Failed to send message: ${toErrorMessage(error)}`,
      });
    } finally {
      setIsSending(false);
    }
  };

  const submitAskUserQuestion = async (answerText: string): Promise<void> => {
    if (!pendingQuestion) {
      return;
    }

    const question = pendingQuestion.questions[pendingQuestion.activeIndex];
    if (!question) {
      return;
    }

    const normalizedAnswer = normalizeQuestionAnswer(answerText, question);
    const nextAnswers = {
      ...pendingQuestion.answers,
      [question.question]: normalizedAnswer,
    };

    if (pendingQuestion.activeIndex < pendingQuestion.questions.length - 1) {
      setPendingQuestion({
        ...pendingQuestion,
        activeIndex: pendingQuestion.activeIndex + 1,
        answers: nextAnswers,
      });
      setInputValue("");
      setQuestionError(null);
      return;
    }

    const payload: Record<string, string> = {};
    for (const questionEntry of pendingQuestion.questions) {
      payload[questionEntry.question] = nextAnswers[questionEntry.question] ?? "";
    }

    setIsAnsweringQuestion(true);
    setQuestionError(null);
    try {
      const result = await api.workspace.answerAskUserQuestion({
        workspaceId: workspaceId,
        toolCallId: pendingQuestion.toolCallId,
        answers: payload,
      });

      if (!result.success) {
        setQuestionError(result.error);
        return;
      }

      setPendingQuestion(null);
      setInputValue("");
    } catch (error: unknown) {
      setQuestionError(`Failed to submit answer: ${toErrorMessage(error)}`);
    } finally {
      setIsAnsweringQuestion(false);
    }
  };

  const handleInputSubmit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) {
      return;
    }

    if (isSending || isAnsweringQuestion) {
      return;
    }

    setInputValue("");

    if (pendingQuestion) {
      submitAskUserQuestion(trimmed).catch((error: unknown) => {
        setQuestionError(`Failed to submit answer: ${toErrorMessage(error)}`);
      });
      return;
    }

    sendMessage(trimmed).catch((error: unknown) => {
      dispatch({
        type: "SET_ERROR",
        error: `Failed to send message: ${toErrorMessage(error)}`,
      });
    });
  };

  const interruptStream = async (): Promise<void> => {
    if (!props.state.chat.isStreaming) {
      return;
    }

    setIsInterrupting(true);
    try {
      const result = await api.workspace.interruptStream({
        workspaceId: workspaceId,
        options: { abandonPartial: false },
      });

      if (!result.success) {
        dispatch({ type: "SET_ERROR", error: `Interrupt failed: ${result.error}` });
      }
    } catch (error: unknown) {
      dispatch({ type: "SET_ERROR", error: `Interrupt failed: ${toErrorMessage(error)}` });
    } finally {
      setIsInterrupting(false);
    }
  };

  useInput((input, key) => {
    if (!(key.ctrl && input === "c")) {
      return;
    }

    if (!props.state.chat.isStreaming || isInterrupting) {
      return;
    }

    interruptStream().catch((error: unknown) => {
      dispatch({ type: "SET_ERROR", error: `Interrupt failed: ${toErrorMessage(error)}` });
    });
  });

  const totalMessages = props.state.chat.messages.length;
  const visibleStartIndex = Math.max(0, totalMessages - MESSAGE_VIEWPORT_SIZE);
  const visibleMessages = props.state.chat.messages.slice(visibleStartIndex);
  const activeToolCalls = Array.from(props.state.chat.activeToolCalls.entries());

  const currentQuestion = pendingQuestion
    ? (pendingQuestion.questions[pendingQuestion.activeIndex] ?? null)
    : null;

  return (
    <Box flexDirection="column">
      <Text bold>Chat · {workspaceId}</Text>
      <Text dimColor>
        Model: {options.model} · Agent: {options.agentId} · Esc: back · Ctrl+C: interrupt
      </Text>
      <Text dimColor>
        {props.state.chat.isCaughtUp
          ? "Live stream connected"
          : "Syncing chat history from workspace…"}
      </Text>

      {props.state.error ? <Text color="red">{props.state.error}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        {visibleStartIndex > 0 ? (
          <Text dimColor>↑ {visibleStartIndex} earlier message(s)</Text>
        ) : null}

        {visibleMessages.length === 0 ? (
          <Text dimColor>No messages yet. Send a message to begin.</Text>
        ) : (
          visibleMessages.map((message, index) => {
            const color = message.role === "user" ? "green" : "magenta";
            const label = message.role === "user" ? "You" : "Assistant";
            const content = message.content.trim().length > 0 ? message.content : "(no text)";

            return (
              <Text color={color} key={`chat-message-${visibleStartIndex + index}`}>
                {label}: {content}
              </Text>
            );
          })
        )}

        {props.state.chat.streamingBuffer ? (
          <Text color="yellow" dimColor>
            Assistant (typing): {props.state.chat.streamingBuffer}
          </Text>
        ) : null}
      </Box>

      {activeToolCalls.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Active tool calls</Text>
          {activeToolCalls.map(([toolCallId, call]) => (
            <Text key={toolCallId} dimColor>
              • {call.toolName} ({call.status})
            </Text>
          ))}
        </Box>
      ) : null}

      {pendingQuestion && currentQuestion ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow" bold>
            ask_user_question · {pendingQuestion.activeIndex + 1}/{pendingQuestion.questions.length}
          </Text>

          {pendingQuestion.questions.map((question, index) => {
            const answered = pendingQuestion.answers[question.question];
            const marker = index === pendingQuestion.activeIndex ? "›" : " ";
            return (
              <Text
                key={`${question.question}-${index}`}
                dimColor={index !== pendingQuestion.activeIndex}
              >
                {marker} {index + 1}. {question.header}
                {answered ? " (answered)" : ""}
              </Text>
            );
          })}

          <Text>{currentQuestion.question}</Text>
          {currentQuestion.options.map((option, index) => (
            <Text dimColor key={`${option.label}-${index}`}>
              {index + 1}. {option.label} — {option.description}
            </Text>
          ))}
          <Text dimColor>
            Type an answer (or option number
            {currentQuestion.multiSelect ? "s separated by commas" : ""}) and press Enter.
          </Text>
          {questionError ? <Text color="red">{questionError}</Text> : null}
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color="cyan">{pendingQuestion ? "answer> " : "you> "}</Text>
        <TextInput
          value={inputValue}
          onChange={setInputValue}
          onSubmit={handleInputSubmit}
          placeholder={pendingQuestion ? "Type your answer" : "Type a message"}
          focus={!isSending && !isAnsweringQuestion}
        />
      </Box>

      {isSending ? <Text dimColor>Sending message…</Text> : null}
      {isAnsweringQuestion ? <Text dimColor>Submitting answer…</Text> : null}
      {isInterrupting ? <Text dimColor>Interrupting stream…</Text> : null}
    </Box>
  );
}
