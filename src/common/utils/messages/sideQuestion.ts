import type { MuxMessage, MuxMetadata } from "@/common/types/message";

export const SIDE_QUESTION_METADATA_TYPE = "side-question";
export const SIDE_QUESTION_ANSWER_METADATA_TYPE = "side-question-answer";

type SideQuestionMetadata = Extract<
  NonNullable<MuxMetadata["muxMetadata"]>,
  { type: typeof SIDE_QUESTION_METADATA_TYPE }
>;

type SideQuestionAnswerMetadata = Extract<
  NonNullable<MuxMetadata["muxMetadata"]>,
  { type: typeof SIDE_QUESTION_ANSWER_METADATA_TYPE }
>;

export type SideQuestionUserMuxMessage = MuxMessage & {
  role: "user";
  metadata: MuxMetadata & { muxMetadata: SideQuestionMetadata };
};

export type SideQuestionAnswerMuxMessage = MuxMessage & {
  role: "assistant";
  metadata: MuxMetadata & { muxMetadata: SideQuestionAnswerMetadata };
};

export function isSideQuestionUserMessage(
  message: MuxMessage
): message is SideQuestionUserMuxMessage {
  return (
    message.role === "user" && message.metadata?.muxMetadata?.type === SIDE_QUESTION_METADATA_TYPE
  );
}

export function isSideQuestionAnswerMessage(
  message: MuxMessage
): message is SideQuestionAnswerMuxMessage {
  return (
    message.role === "assistant" &&
    message.metadata?.muxMetadata?.type === SIDE_QUESTION_ANSWER_METADATA_TYPE
  );
}

export function isSideQuestionMessage(message: MuxMessage): boolean {
  const type = message.metadata?.muxMetadata?.type;
  return type === SIDE_QUESTION_METADATA_TYPE || type === SIDE_QUESTION_ANSWER_METADATA_TYPE;
}

/**
 * Remove durable /btw side-question rows from provider-bound transcripts.
 *
 * /btw exchanges are persisted so the UI can reload them, but they are a
 * forked read-only aside and must not pollute future main-agent requests.
 * Preserve array identity when nothing is removed so diagnostics can tell
 * ordinary context-boundary slicing apart from /btw filtering.
 */
export function filterSideQuestionMessages(messages: MuxMessage[]): MuxMessage[] {
  if (!messages.some(isSideQuestionMessage)) {
    return messages;
  }
  return messages.filter((message) => !isSideQuestionMessage(message));
}
