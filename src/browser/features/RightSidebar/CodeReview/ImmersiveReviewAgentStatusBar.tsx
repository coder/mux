/**
 * ImmersiveReviewAgentStatusBar — pinned to the top of full-screen immersive
 * review. While the user reviews code in immersive mode the chat transcript and
 * composer-adjacent status (TODO plan, streaming barrier) are hidden behind the
 * opaque overlay, so a common workflow — reviewing while waiting on the agent —
 * loses all signal about what the agent is doing.
 *
 * This bar restores that signal without leaving immersive:
 *   - the agent's TODO plan as a single horizontal strip (collapsible,
 *     persisted) so it reserves minimal review height, and
 *   - live streaming status (starting / streaming / awaiting a question).
 *
 * Design notes:
 *   - Subscriptions live in this leaf component (not in ImmersiveReviewView) so
 *     per-token streaming/todo churn doesn't re-render the large diff tree.
 *   - Flash-free: the streaming chip is gated on the *held* phase from
 *     useWorkspaceStreamingStatusPhase (150ms), so brief starting<->streaming
 *     handoffs don't blink. Because TODO plans persist across streams, the bar
 *     stays mounted between turns and only unmounts once both the held phase
 *     clears AND there are no todos left to show — no mid-review flicker.
 *   - Crash-safe: when the workspace isn't registered in the store yet (tests,
 *     storybook, teardown) the subscriptions fall back to empty/idle instead of
 *     throwing, so the bar simply renders nothing.
 */

import React, { useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, CircleHelp, List, Loader2 } from "lucide-react";
import { TodoList } from "@/browser/components/TodoList/TodoList";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import {
  getWorkspaceStreamingStatusPhase,
  useWorkspaceStreamingStatusPhase,
} from "@/browser/hooks/useWorkspaceStreamingStatusPhase";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { getImmersiveReviewAgentBarExpandedKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import type { TodoItem } from "@/common/types/tools";

// Stable empty-plan reference for the unregistered case (tests, storybook,
// teardown). Module-level so the `todos` snapshot stays referentially stable
// and useSyncExternalStore's "getSnapshot should be cached" guard doesn't loop.
const EMPTY_TODOS: TodoItem[] = [];

interface ImmersiveReviewAgentStatusBarProps {
  workspaceId: string;
}

export const ImmersiveReviewAgentStatusBar: React.FC<ImmersiveReviewAgentStatusBarProps> = ({
  workspaceId,
}) => {
  const [expanded, setExpanded] = usePersistedState(
    getImmersiveReviewAgentBarExpandedKey(workspaceId),
    true
  );

  // Subscribe to each field this bar uses as its OWN snapshot rather than
  // returning the whole WorkspaceState object. getWorkspaceState is version-
  // cached, so its reference changes on EVERY state bump (e.g. each streamed
  // message) — returning it wholesale would re-render the bar on every token.
  // Per-field selectors keep the bar stable: primitives compare by value, and
  // `todos` keeps a stable reference from the aggregator (same basis as
  // PinnedTodoList reading only `.todos`).
  const workspaceStore = useWorkspaceStoreRaw();
  const subscribe = (callback: () => void) =>
    workspaceStore.hasRegisteredWorkspace(workspaceId)
      ? workspaceStore.subscribeKey(workspaceId, callback)
      : () => undefined;
  const todos = useSyncExternalStore(subscribe, () =>
    workspaceStore.hasRegisteredWorkspace(workspaceId)
      ? workspaceStore.getWorkspaceState(workspaceId).todos
      : EMPTY_TODOS
  );
  const canInterrupt = useSyncExternalStore(subscribe, () =>
    workspaceStore.hasRegisteredWorkspace(workspaceId)
      ? workspaceStore.getWorkspaceState(workspaceId).canInterrupt
      : false
  );
  // Sidebar derives `isStarting` directly from `isStreamStarting`.
  const isStarting = useSyncExternalStore(subscribe, () =>
    workspaceStore.hasRegisteredWorkspace(workspaceId)
      ? workspaceStore.getWorkspaceState(workspaceId).isStreamStarting
      : false
  );
  const awaitingUserQuestion = useSyncExternalStore(subscribe, () =>
    workspaceStore.hasRegisteredWorkspace(workspaceId)
      ? workspaceStore.getWorkspaceState(workspaceId).awaitingUserQuestion
      : false
  );

  // Held phase keeps the streaming chip steady across the starting->streaming
  // handoff so it doesn't blink out for a frame between adjacent state settles.
  const phase = getWorkspaceStreamingStatusPhase({ canInterrupt, isStarting });
  const phaseSource = canInterrupt ? "streaming" : isStarting ? "pre-stream" : null;
  const { displayPhase } = useWorkspaceStreamingStatusPhase(phase, phaseSource);

  const hasTodos = todos.length > 0;
  const isStreamingStatusVisible = displayPhase !== null || awaitingUserQuestion;

  // Nothing to surface: don't reserve any vertical space in the review viewport.
  if (!hasTodos && !isStreamingStatusVisible) {
    return null;
  }

  const inProgressCount = todos.filter((todo) => todo.status === "in_progress").length;
  const pendingCount = todos.filter((todo) => todo.status === "pending").length;
  const completedCount = todos.length - inProgressCount - pendingCount;
  const summaryParts: string[] = [];
  if (inProgressCount > 0) {
    summaryParts.push(`${inProgressCount} in progress`);
  }
  if (pendingCount > 0) {
    summaryParts.push(`${pendingCount} pending`);
  }
  if (summaryParts.length === 0 && hasTodos) {
    summaryParts.push(`${completedCount} completed`);
  }

  // role=status + aria-live so screen readers announce streaming/question
  // transitions while the user is focused on the diff.
  const statusChip = (() => {
    if (awaitingUserQuestion) {
      return (
        <span className="bg-plan-mode-alpha text-plan-mode-light flex items-center gap-1 rounded px-1.5 py-0.5 font-medium">
          <CircleHelp aria-hidden="true" className="h-3 w-3 shrink-0" />
          <span>Mux has a question</span>
        </span>
      );
    }
    if (displayPhase === "starting") {
      return (
        <span className="text-muted flex items-center gap-1">
          <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span>Starting…</span>
        </span>
      );
    }
    if (displayPhase === "streaming") {
      return (
        <span className="text-muted flex items-center gap-1">
          <Loader2 aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin opacity-70" />
          <span>Streaming…</span>
        </span>
      );
    }
    return null;
  })();

  // `alignEnd` pushes the chip to the right with the TODO summary on its left;
  // without a plan there's nothing on the left, so the chip is left-aligned
  // instead of floating alone on the far right of an otherwise-empty bar.
  const renderStatusChip = (alignEnd: boolean) => (
    <div
      className={cn("flex shrink-0 items-center gap-2", alignEnd && "ml-auto")}
      role="status"
      aria-live="polite"
      data-testid="immersive-agent-status-chip"
    >
      {statusChip}
    </div>
  );

  return (
    <div
      className="border-border-light bg-dark border-b text-[11px]"
      data-testid="immersive-agent-status-bar"
      data-component="ImmersiveReviewAgentStatusBar"
    >
      {hasTodos ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="group flex h-7 w-full items-center gap-2 px-3 text-left leading-none"
          aria-expanded={expanded}
        >
          <List
            aria-hidden="true"
            className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors"
          />
          <span className="text-muted group-hover:text-secondary min-w-0 truncate transition-colors">
            <span className="font-medium">TODO</span>
            {summaryParts.length > 0 && <> · {summaryParts.join(" · ")}</>}
          </span>
          {renderStatusChip(true)}
          {expanded ? (
            <ChevronDown className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          ) : (
            <ChevronRight className="text-muted group-hover:text-secondary size-3.5 shrink-0 transition-colors" />
          )}
        </button>
      ) : (
        // Streaming/question only (no plan yet): static row, nothing to expand.
        // Chip is left-aligned here so it reads as a status label rather than
        // hugging the far right of an otherwise-empty bar.
        <div className="flex h-7 w-full items-center gap-2 px-3 leading-none">
          {renderStatusChip(false)}
        </div>
      )}
      {hasTodos && expanded && (
        // Horizontal strip: one row tall (the list scrolls sideways), so the
        // plan costs minimal vertical space in the review viewport.
        <TodoList todos={todos} layout="horizontal" />
      )}
    </div>
  );
};
