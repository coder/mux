import type { DisplayedMessage } from "@/common/types/message";

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
 * Continue aligning a side-question branch after the first hand-off from
 * bottom-lock. The first scroll can happen before there is enough content below
 * the branch for the browser to place it in a readable position, so active side
 * holds keep re-aligning on subsequent stream updates until the side answer has
 * produced one final settled render. If no answer row is currently rendered
 * (model setup lag, retry, or failure), the ChatPane keeps that target alive
 * only while DOM geometry says the attempted alignment is still bottom-clamped.
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
      message.type === "user" &&
      message.isSideQuestion === true &&
      message.historyId === activeTargetHistoryId
  );
  if (sideQuestionIndex === -1) {
    const sideAnswer = messages.find(
      (message): message is Extract<DisplayedMessage, { type: "assistant" }> =>
        message.type === "assistant" &&
        message.isSideAnswer === true &&
        message.historyId === activeTargetHistoryId
    );
    if (!sideAnswer) {
      return { keepActive: false };
    }

    return {
      targetHistoryId: activeTargetHistoryId,
      keepActive: sideAnswer.isStreaming === true,
    };
  }

  const nextMessage = messages[sideQuestionIndex + 1];
  if (nextMessage?.type === "assistant" && nextMessage.isSideAnswer === true) {
    return {
      targetHistoryId: activeTargetHistoryId,
      keepActive: nextMessage.isStreaming === true,
    };
  }

  return { targetHistoryId: activeTargetHistoryId, keepActive: false };
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
      const wasHeld = state.heldSideQuestionIds.has(message.historyId);
      const nextMessage = messages[index + 1];
      const branchEndIndex =
        nextMessage?.type === "assistant" && nextMessage.isSideAnswer === true ? index + 1 : index;
      const hasTranscriptRowsBelow = branchEndIndex < messages.length - 1;
      if (!state.initialized || wasHeld) {
        nextHeldSideQuestionIds.add(message.historyId);
        continue;
      }
      if (hasTranscriptRowsBelow) {
        nextHeldSideQuestionIds.add(message.historyId);
        targetHistoryId = message.historyId;
      }
      continue;
    }

    if (message.type !== "assistant" || message.isSideAnswer !== true) {
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
      sideQuestion?.type === "user" && sideQuestion.isSideQuestion === true
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
