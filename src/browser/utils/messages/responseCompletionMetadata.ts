export type ResponseCompleteMetadata =
  | {
      kind: "response";
      // Notification policy should follow the user-visible terminal turn rather than every
      // intermediate stream boundary. Another queued/auto-dispatched follow-up means this
      // completion is only a handoff, so it should not notify on its own.
      hasAutoFollowUp: boolean;
    }
  | {
      kind: "compaction";
      hasAutoFollowUp: boolean;
      isIdle?: boolean;
    };

export interface ResponseCompleteEvent {
  workspaceId: string;
  isFinal: boolean;
  finalText?: string;
  messageId?: string;
  completion?: ResponseCompleteMetadata;
  completedAt?: number | null;
}

export type ResponseCompleteHandler = (event: ResponseCompleteEvent) => void;

export interface ResponseCompletionState {
  isCompacting: boolean;
  hasCompactionContinue: boolean;
  hasQueuedFollowUp: boolean;
  // Idle compaction is maintenance work, so downstream notification policy must
  // be able to suppress the final completion even when the workspace is selected.
  isIdleCompaction?: boolean;
}

export function buildResponseCompleteMetadata(
  state: ResponseCompletionState
): ResponseCompleteMetadata | undefined {
  const hasAutoFollowUp = state.hasCompactionContinue || state.hasQueuedFollowUp;
  if (!state.isCompacting && !hasAutoFollowUp) {
    return undefined;
  }

  if (state.isCompacting) {
    return {
      kind: "compaction",
      hasAutoFollowUp,
      ...(state.isIdleCompaction ? { isIdle: true } : {}),
    };
  }

  return {
    kind: "response",
    hasAutoFollowUp,
  };
}

export function buildAggregateResponseCompleteMetadata(
  states: Iterable<ResponseCompletionState>
): ResponseCompleteMetadata | undefined {
  let isCompacting = false;
  let hasCompactionContinue = false;
  let hasQueuedFollowUp = false;
  let isIdleCompaction = false;

  for (const state of states) {
    isCompacting ||= state.isCompacting;
    hasCompactionContinue ||= state.hasCompactionContinue;
    hasQueuedFollowUp ||= state.hasQueuedFollowUp;
    isIdleCompaction ||= state.isIdleCompaction === true;
  }

  return buildResponseCompleteMetadata({
    isCompacting,
    hasCompactionContinue,
    hasQueuedFollowUp,
    isIdleCompaction,
  });
}

export function createIdleCompactionCompletion(hasAutoFollowUp: boolean): ResponseCompleteMetadata {
  return {
    kind: "compaction",
    hasAutoFollowUp,
    isIdle: true,
  };
}

export function shouldNotifyOnResponseComplete(
  completion: ResponseCompleteMetadata | undefined
): boolean {
  if (completion?.kind === "compaction" && completion.isIdle) {
    return false;
  }

  return completion?.hasAutoFollowUp !== true;
}

export function getResponseCompleteNotificationBody(
  finalText: string | undefined,
  completion: ResponseCompleteMetadata | undefined
): string {
  if (completion?.kind === "compaction") {
    return "Compaction complete";
  }

  if (!finalText) {
    return "Response complete";
  }

  return finalText.length > 200 ? `${finalText.slice(0, 197)}…` : finalText;
}
