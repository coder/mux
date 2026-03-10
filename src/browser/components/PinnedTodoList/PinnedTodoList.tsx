import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { TodoList } from "../TodoList/TodoList";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { cn } from "@/common/lib/utils";
import assert from "@/common/utils/assert";

interface PinnedTodoListProps {
  workspaceId: string;
}

function getPinnedTodoExpandedKey(workspaceId: string): string {
  assert(workspaceId.length > 0, "Pinned todo expansion state requires a workspace ID");
  return `pinnedTodoExpanded:${workspaceId}`;
}

/**
 * Pinned TODO list displayed at bottom of chat (before StreamingBarrier).
 * Shows current TODOs — incomplete plans persist across streams until the agent updates them,
 * while fully completed plans clear when the final stream ends for this workspace.
 * The pinned panel can also auto-collapse after a stream ends for this workspace.
 * Reuses TodoList component for consistent styling.
 *
 * Relies on natural reference stability from MapStore + Aggregator architecture:
 * - Aggregator.getCurrentTodos() returns direct reference (not a copy)
 * - Reference only changes when todos are actually modified
 * - MapStore caches WorkspaceState per version, avoiding unnecessary recomputation
 */
export const PinnedTodoList: React.FC<PinnedTodoListProps> = ({ workspaceId }) => {
  const [expanded, setExpanded] = usePersistedState(getPinnedTodoExpandedKey(workspaceId), true);

  const workspaceStore = useWorkspaceStoreRaw();
  const subscribeToWorkspace = (callback: () => void) =>
    workspaceStore.subscribeKey(workspaceId, callback);
  const todos = useSyncExternalStore(
    subscribeToWorkspace,
    () => workspaceStore.getWorkspaceState(workspaceId).todos
  );
  const canInterrupt = useSyncExternalStore(
    subscribeToWorkspace,
    () => workspaceStore.getWorkspaceState(workspaceId).canInterrupt
  );
  const previousCanInterruptRef = useRef(canInterrupt);

  useEffect(() => {
    const previousCanInterrupt = previousCanInterruptRef.current;

    // Only persist an auto-collapse when this workspace actually has a visible pinned TODO panel.
    if (previousCanInterrupt && !canInterrupt && todos.length > 0) {
      setExpanded(false);
    }

    previousCanInterruptRef.current = canInterrupt;
  }, [canInterrupt, setExpanded, todos.length]);

  // No todos have been written yet in this session
  if (todos.length === 0) {
    return null;
  }

  return (
    <div className="bg-panel-background mt-2 max-h-[300px] overflow-y-auto border-t border-dashed border-[hsl(0deg_0%_28.64%)]">
      <div
        className="text-secondary flex cursor-pointer items-center gap-1 px-2 pt-1 pb-0.5 font-mono text-[10px] font-semibold tracking-wider select-none hover:opacity-80"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={cn(
            "inline-block transition-transform duration-200 text-[8px]",
            expanded ? "rotate-90" : "rotate-0"
          )}
        >
          ▶
        </span>
        TODO{expanded ? ":" : ""}
      </div>
      {expanded && <TodoList todos={todos} />}
    </div>
  );
};
