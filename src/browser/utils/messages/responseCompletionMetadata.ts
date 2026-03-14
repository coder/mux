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

export interface ResponseCompletionState {
  isCompacting: boolean;
  hasCompactionContinue: boolean;
  hasQueuedFollowUp: boolean;
}

export function buildResponseCompleteMetadata(
  state: ResponseCompletionState
): ResponseCompleteMetadata | undefined {
  const hasAutoFollowUp = state.hasCompactionContinue || state.hasQueuedFollowUp;
  if (!state.isCompacting && !hasAutoFollowUp) {
    return undefined;
  }

  return {
    kind: state.isCompacting ? "compaction" : "response",
    hasAutoFollowUp,
  };
}

export function markCompletionHasAutoFollowUp(
  completion: ResponseCompleteMetadata | undefined
): ResponseCompleteMetadata {
  if (completion) {
    return {
      ...completion,
      hasAutoFollowUp: true,
    };
  }

  return {
    kind: "response",
    hasAutoFollowUp: true,
  };
}

export function createIdleCompactionCompletion(hasAutoFollowUp: boolean): ResponseCompleteMetadata {
  return {
    kind: "compaction",
    hasAutoFollowUp,
    isIdle: true,
  };
}
