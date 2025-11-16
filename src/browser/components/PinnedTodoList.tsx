import React, { useSyncExternalStore } from "react";
import { TodoList } from "./TodoList";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { cn } from "@/common/lib/utils";

interface PinnedTodoListProps {
  workspaceId: string;
}

/**
 * Pinned TODO list displayed at bottom of chat (before StreamingBarrier).
 * Shows current TODOs from active stream only - automatically cleared when stream ends.
 * Reuses TodoList component for consistent styling.
 *
 * Relies on natural reference stability from MapStore + Aggregator architecture:
 * - Aggregator.getCurrentTodos() returns direct reference (not a copy)
 * - Reference only changes when todos are actually modified
 * - MapStore caches WorkspaceState per version, avoiding unnecessary recomputation
 * - Todos are cleared by StreamingMessageAggregator when stream completes
 */
export const PinnedTodoList: React.FC<PinnedTodoListProps> = ({ workspaceId }) => {
  const [expanded, setExpanded] = usePersistedState("pinnedTodoExpanded", true);

  const workspaceStore = useWorkspaceStoreRaw();
  const todos = useSyncExternalStore(
    (callback) => workspaceStore.subscribeKey(workspaceId, callback),
    () => workspaceStore.getWorkspaceState(workspaceId).todos
  );

  // Todos are cleared when stream ends, so if there are todos they're from an active stream
  if (todos.length === 0) {
    return null;
  }

  return (
    <div className="bg-panel-background m-0 max-h-[300px] overflow-y-auto border-t border-dashed border-[hsl(0deg_0%_28.64%)]">
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
