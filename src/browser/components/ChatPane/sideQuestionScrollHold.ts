import type { DisplayedMessage, SideQuestionDisplayBranch } from "@/common/types/message";

export interface SideQuestionScrollHoldState {
  initialized: boolean;
  heldSideQuestionIds: ReadonlySet<string>;
  previouslyStreamingSideAnswerIds: ReadonlySet<string>;
  heldSideAnswerIds: ReadonlySet<string>;
}

export interface SideQuestionScrollHoldResult {
  nextState: SideQuestionScrollHoldState;
  targetHistoryId?: string;
}

export interface ActiveSideQuestionScrollHoldResult {
  keepActive: boolean;
  targetHistoryId?: string;
}

interface ScrollHoldViewportGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  getBoundingClientRect(): Pick<DOMRectReadOnly, "top">;
}

interface ScrollHoldTargetGeometry {
  getBoundingClientRect(): Pick<DOMRectReadOnly, "top">;
}

interface ScrollHoldBottomClampOptions {
  scrollportStartTop?: number;
}

const BOTTOM_CLAMP_EPSILON_PX = 1;
const TARGET_START_ALIGNMENT_EPSILON_PX = 2;

function getInterruptedSideQuestionBranch(
  message: DisplayedMessage
): SideQuestionDisplayBranch | undefined {
  if (message.type !== "user" && message.type !== "assistant") {
    return undefined;
  }

  return message.sideQuestionBranch?.placement === "interrupted"
    ? message.sideQuestionBranch
    : undefined;
}

function isInterruptedSideQuestionUser(
  message: DisplayedMessage
): message is Extract<DisplayedMessage, { type: "user" }> {
  return (
    message.type === "user" &&
    message.isSideQuestion === true &&
    getInterruptedSideQuestionBranch(message) !== undefined
  );
}

function isInterruptedSideQuestionAnswer(
  message: DisplayedMessage
): message is Extract<DisplayedMessage, { type: "assistant" }> {
  return (
    message.type === "assistant" &&
    message.isSideAnswer === true &&
    getInterruptedSideQuestionBranch(message) !== undefined
  );
}

function isStreamingHistoryRow(message: DisplayedMessage, historyId: string): boolean {
  return (
    "historyId" in message &&
    message.historyId === historyId &&
    "isStreaming" in message &&
    message.isStreaming === true
  );
}

function isInterruptedBranchStreaming(
  messages: readonly DisplayedMessage[],
  branch: SideQuestionDisplayBranch | undefined
): boolean {
  const interruptedMessageId = branch?.interruptedMessageId;
  if (branch?.placement !== "interrupted" || !interruptedMessageId) {
    return false;
  }

  return messages.some((message) => isStreamingHistoryRow(message, interruptedMessageId));
}

function readCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function getSideQuestionScrollHoldScrollportStartTop(scrollContainer: HTMLElement): number {
  const containerTop = scrollContainer.getBoundingClientRect().top;
  const style = scrollContainer.ownerDocument.defaultView?.getComputedStyle(scrollContainer);
  if (!style) {
    return containerTop;
  }

  // scrollIntoView aligns to the scrollport's padding edge. The transcript
  // scroller has padding, so comparing against the border box would mistake a
  // correctly aligned /btw row for a bottom-clamped row and keep the hold alive.
  return (
    containerTop + readCssPixelValue(style.borderTopWidth) + readCssPixelValue(style.paddingTop)
  );
}

/**
 * `scrollIntoView({ block: "start" })` silently degrades to bottom-clamping when
 * there is not yet enough transcript content below a /btw branch. Keep the
 * short-lived hold only in that clamped state; once the target can actually sit
 * at the transcript scrollport start, the side branch must stop owning scroll so
 * it cannot become permanent bottom clutter.
 */
export function isSideQuestionScrollHoldBottomClamped(
  scrollContainer: ScrollHoldViewportGeometry,
  targetElement: ScrollHoldTargetGeometry,
  options: ScrollHoldBottomClampOptions = {}
): boolean {
  const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
  const isAtScrollBottom = maxScrollTop - scrollContainer.scrollTop <= BOTTOM_CLAMP_EPSILON_PX;
  if (!isAtScrollBottom) {
    return false;
  }

  const scrollportStartTop =
    options.scrollportStartTop ?? scrollContainer.getBoundingClientRect().top;
  const targetTop = targetElement.getBoundingClientRect().top;
  return targetTop > scrollportStartTop + TARGET_START_ALIGNMENT_EPSILON_PX;
}

/**
 * Continue aligning an interrupted side-question branch after the first hand-off
 * from bottom-lock. A /btw hold is a finite lease: it may stay active while the
 * side answer or interrupted main message is still streaming, but settled
 * branches must release even if browser start-alignment was bottom-clamped.
 */
export function findActiveSideQuestionScrollHoldTarget(
  messages: readonly DisplayedMessage[],
  activeTargetHistoryId: string | null | undefined
): ActiveSideQuestionScrollHoldResult {
  if (!activeTargetHistoryId) {
    return { keepActive: false };
  }

  const sideQuestionIndex = messages.findIndex(
    (message) =>
      isInterruptedSideQuestionUser(message) && message.historyId === activeTargetHistoryId
  );
  if (sideQuestionIndex === -1) {
    const sideAnswer = messages.find(
      (message): message is Extract<DisplayedMessage, { type: "assistant" }> =>
        isInterruptedSideQuestionAnswer(message) && message.historyId === activeTargetHistoryId
    );
    if (!sideAnswer) {
      return { keepActive: false };
    }

    return {
      targetHistoryId: activeTargetHistoryId,
      keepActive:
        sideAnswer.isStreaming === true ||
        isInterruptedBranchStreaming(messages, sideAnswer.sideQuestionBranch),
    };
  }

  const sideQuestion = messages[sideQuestionIndex];
  const sideQuestionBranch = getInterruptedSideQuestionBranch(sideQuestion);
  if (!sideQuestionBranch) {
    return { keepActive: false };
  }
  const nextMessage = messages[sideQuestionIndex + 1];
  if (
    nextMessage !== undefined &&
    isInterruptedSideQuestionAnswer(nextMessage) &&
    nextMessage.sideQuestionBranch?.branchId === sideQuestionBranch?.branchId
  ) {
    return {
      targetHistoryId: activeTargetHistoryId,
      keepActive:
        nextMessage.isStreaming === true ||
        isInterruptedBranchStreaming(messages, sideQuestionBranch),
    };
  }

  return {
    targetHistoryId: activeTargetHistoryId,
    keepActive: isInterruptedBranchStreaming(messages, sideQuestionBranch),
  };
}

/**
 * Detect when a live /btw branch gains transcript rows below it while
 * bottom-lock is still active. The user asked for the aside, so the first
 * post-aside main-agent delta must transfer scroll ownership to the side branch
 * instead of yanking the viewport down to the live transcript tail.
 */
export function findSideQuestionScrollHoldTarget(
  messages: readonly DisplayedMessage[],
  state: SideQuestionScrollHoldState
): SideQuestionScrollHoldResult {
  const nextHeldSideQuestionIds = new Set<string>();
  const nextStreamingSideAnswerIds = new Set<string>();
  const nextHeldSideAnswerIds = new Set<string>();
  let targetHistoryId: string | undefined;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];

    if (message.type === "user" && message.isSideQuestion === true) {
      const sideQuestionHistoryId = message.historyId;
      if (!isInterruptedSideQuestionUser(message)) {
        // Track standalone/stale side-question rows as already seen. If their
        // anchor arrives later and the display projection flips them to
        // interrupted, that historical row must not acquire a fresh scroll lease.
        nextHeldSideQuestionIds.add(sideQuestionHistoryId);
        continue;
      }

      const wasHeld = state.heldSideQuestionIds.has(sideQuestionHistoryId);
      const nextMessage = messages[index + 1];
      const branchEndIndex =
        nextMessage !== undefined &&
        isInterruptedSideQuestionAnswer(nextMessage) &&
        nextMessage.sideQuestionBranch?.branchId === message.sideQuestionBranch?.branchId
          ? index + 1
          : index;
      const hasTranscriptRowsBelow = branchEndIndex < messages.length - 1;
      if (!state.initialized || wasHeld) {
        nextHeldSideQuestionIds.add(sideQuestionHistoryId);
        continue;
      }
      if (hasTranscriptRowsBelow) {
        nextHeldSideQuestionIds.add(sideQuestionHistoryId);
        targetHistoryId = sideQuestionHistoryId;
      }
      continue;
    }

    if (!isInterruptedSideQuestionAnswer(message)) {
      continue;
    }

    if (message.isStreaming) {
      nextStreamingSideAnswerIds.add(message.historyId);
    }

    const wasHeld = state.heldSideAnswerIds.has(message.historyId);
    if (wasHeld) {
      nextHeldSideAnswerIds.add(message.historyId);
      continue;
    }

    const hasTranscriptRowsBelow = index < messages.length - 1;
    if (!hasTranscriptRowsBelow) {
      continue;
    }

    const wasStreaming = state.previouslyStreamingSideAnswerIds.has(message.historyId);
    const shouldHold = message.isStreaming || wasStreaming;
    if (!shouldHold) {
      continue;
    }

    nextHeldSideAnswerIds.add(message.historyId);

    const sideQuestion = messages[index - 1];
    targetHistoryId =
      sideQuestion !== undefined &&
      isInterruptedSideQuestionUser(sideQuestion) &&
      sideQuestion.sideQuestionBranch?.branchId === message.sideQuestionBranch?.branchId
        ? sideQuestion.historyId
        : message.historyId;
  }

  return {
    nextState: {
      initialized: true,
      heldSideQuestionIds: nextHeldSideQuestionIds,
      previouslyStreamingSideAnswerIds: nextStreamingSideAnswerIds,
      heldSideAnswerIds: nextHeldSideAnswerIds,
    },
    targetHistoryId,
  };
}
