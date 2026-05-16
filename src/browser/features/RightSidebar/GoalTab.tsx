import { ChevronDown, ChevronRight, Pencil, Target } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  isGoalPendingPersistence,
  type GoalHistoryEntry,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import { parseGoalBudgetInputCents } from "@/common/utils/goals/budgetParser";
// Import shared formatters / status labels from goalToolUtils so the GoalTab
// stays in sync with the tool-call cards (Coder-agents-review nits DEREM-28
// + DEREM-29). Local copies drifted in case (`active` vs `Active`) and could
// drift further as Goal status grows.
import { formatGoalElapsed, goalStatusLabel } from "@/browser/features/Tools/Goal/goalToolUtils";

interface GoalTabProps {
  goal: GoalSnapshot | null;
  /**
   * Completed / cleared / replaced goals for this workspace, newest first.
   * Rendered as a compact "Completed goals" list under the present goal. Old
   * goals are not resumable here — the user can expand a card to read details
   * but the only action is "start a new goal" via the existing entry points.
   */
  history?: GoalHistoryEntry[];
  openCompleteInputRequest?: number;
  // GoalTab UI only invokes user-facing transitions (pause/resume/complete);
  // `budget_limited` is internal-only and is excluded from the public oRPC
  // `setGoal` input shape (Coder-agents-review nit DEREM-53).
  onSetStatus?: (
    status: Exclude<GoalStatus, "budget_limited">,
    completionSummary?: string
  ) => Promise<void> | void;
  /**
   * Persist an in-place objective edit. Wired through `setGoal({ editInPlace:
   * true })` so the goal's `goalId` + accounting are preserved (mirrors the
   * budget / turn-cap inline edits). Optional so storybook stories that only
   * exercise read-only states can omit it.
   */
  onUpdateObjective?: (objective: string) => Promise<void> | void;
  onUpdateBudget?: (budgetCents: number | null) => Promise<void> | void;
  onUpdateTurnCap?: (turnCap: number | null) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
}

// `parseBudgetInput` is now a thin alias for the canonical parser shared
// with the slash command and the command palette (Coder-agents-review P3
// DEREM-21).
const parseBudgetInput = parseGoalBudgetInputCents;

function parseTurnCapInput(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

type EditingField = "objective" | "budget" | "turnCap";

export function GoalTab(props: GoalTabProps) {
  const [isSummaryInputOpen, setIsSummaryInputOpen] = useState(false);
  const [editingField, setEditingField] = useState<EditingField | null>(null);
  const [editValue, setEditValue] = useState("");
  const [summary, setSummary] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const objectiveInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const lastCompleteInputRequestRef = useRef(props.openCompleteInputRequest ?? 0);

  // Hide the inline objective edit when the goal is `complete` — the
  // workspace's only meaningful action there is to start a new goal, which
  // goes through the existing replace flow rather than the in-place rename.
  // Also gate on the pending-persistence flag (parity with `canEdit`) so
  // mid-stream / pending goals don't expose a write affordance.
  const canEditObjective =
    props.goal != null &&
    props.goal.status !== "complete" &&
    !isGoalPendingPersistence(props.goal) &&
    props.onUpdateObjective != null;

  const openSummaryInput = (origin: HTMLElement | null) => {
    originRef.current = origin;
    setSummary("");
    setError(null);
    setIsSummaryInputOpen(true);
  };

  const closeSummaryInput = () => {
    setIsSummaryInputOpen(false);
    setError(null);
    originRef.current?.focus();
  };

  const openObjectiveEditor = (origin: HTMLElement | null) => {
    if (!props.goal) {
      return;
    }
    originRef.current = origin;
    setEditValue(props.goal.objective);
    setError(null);
    setEditingField("objective");
  };

  const openBudgetEditor = (origin: HTMLElement | null) => {
    originRef.current = origin;
    setEditValue(props.goal?.budgetCents == null ? "" : (props.goal.budgetCents / 100).toFixed(2));
    setError(null);
    setEditingField("budget");
  };

  const openTurnCapEditor = (origin: HTMLElement | null) => {
    originRef.current = origin;
    setEditValue(props.goal?.turnCap == null ? "" : String(props.goal.turnCap));
    setError(null);
    setEditingField("turnCap");
  };

  const closeEditor = () => {
    setEditingField(null);
    setError(null);
    originRef.current?.focus();
  };

  const submitEditor = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      if (editingField === "objective") {
        const submittedValue = (objectiveInputRef.current?.value ?? editValue).trim();
        if (submittedValue.length === 0) {
          setError("Goal objective is required.");
          objectiveInputRef.current?.focus();
          return;
        }
        if (submittedValue === props.goal?.objective) {
          // No-op edits should not trigger a write (avoids spurious
          // `goal_replaced` lifecycle events and unnecessary IPC traffic).
          closeEditor();
          return;
        }
        await props.onUpdateObjective?.(submittedValue);
      } else if (editingField === "budget") {
        const submittedValue = editInputRef.current?.value ?? editValue;
        const budgetCents = parseBudgetInput(submittedValue);
        if (budgetCents === undefined) {
          setError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
          return;
        }
        await props.onUpdateBudget?.(budgetCents);
      } else if (editingField === "turnCap") {
        const submittedValue = editInputRef.current?.value ?? editValue;
        const turnCap = parseTurnCapInput(submittedValue);
        if (turnCap === undefined) {
          setError("Enter a positive whole-number turn cap, or leave blank for no cap.");
          return;
        }
        await props.onUpdateTurnCap?.(turnCap);
      }
      closeEditor();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal update failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (!isSummaryInputOpen) {
      return;
    }
    inputRef.current?.focus();
  }, [isSummaryInputOpen]);

  useEffect(() => {
    const request = props.openCompleteInputRequest ?? 0;
    if (request === lastCompleteInputRequestRef.current) {
      return;
    }
    lastCompleteInputRequestRef.current = request;
    if (
      request > 0 &&
      props.goal &&
      props.goal.status !== "complete" &&
      !isGoalPendingPersistence(props.goal)
    ) {
      openSummaryInput(
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      );
    }
  }, [props.openCompleteInputRequest, props.goal]);

  const history = props.history ?? [];
  // Hide history entries whose goalId still matches the current goal: this
  // happens when a stale snapshot of the renderer still shows a goal that the
  // backend has just archived (e.g., race during /goal replace). Dedup keeps
  // the list from briefly double-rendering the present goal. The React
  // Compiler memoizes the result of this expression, so no manual `useMemo`
  // is needed (per AGENTS.md "React Compiler enabled").
  const currentGoalId = props.goal?.goalId ?? null;
  const filteredHistory = currentGoalId
    ? history.filter((entry) => entry.goal.goalId !== currentGoalId)
    : history;

  if (!props.goal) {
    return (
      <section className="flex h-full flex-col gap-4 p-4" aria-label="Workspace goal">
        <div className="text-muted border-border-light flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center text-sm">
          <Target className="h-5 w-5" aria-hidden="true" />
          <p>No goal is set for this workspace.</p>
        </div>
        {filteredHistory.length > 0 && <GoalHistorySection entries={filteredHistory} />}
      </section>
    );
  }

  const isPendingPersistence = isGoalPendingPersistence(props.goal);
  const canEdit = !isPendingPersistence;
  const canPause = canEdit && props.goal.status === "active";
  const canResume = canEdit && props.goal.status === "paused";
  const canComplete =
    canEdit && (props.goal.status === "active" || props.goal.status === "budget_limited");

  const setStatus = async (
    status: Exclude<GoalStatus, "budget_limited">,
    completionSummary?: string
  ) => {
    setError(null);
    try {
      await props.onSetStatus?.(status, completionSummary);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal update failed");
    }
  };

  const clearGoal = async () => {
    setError(null);
    try {
      await props.onClear?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal clear failed");
    }
  };

  const submitSummary = async () => {
    const trimmed = (inputRef.current?.value ?? summary).trim();
    if (!trimmed) {
      setError("Completion summary is required.");
      inputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await props.onSetStatus?.("complete", trimmed);
      setIsSummaryInputOpen(false);
      originRef.current?.focus();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal completion failed");
      inputRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  };

  const trapSummaryFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSummaryInput();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'textarea, button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])'
      )
    );
    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section className="flex h-full flex-col gap-4 overflow-y-auto p-4" aria-label="Workspace goal">
      <header className="border-border-light bg-surface-secondary rounded-md border p-3">
        <div className="text-muted mb-1 flex items-center gap-1.5 text-xs font-medium uppercase">
          <Target className="h-3.5 w-3.5" aria-hidden="true" />
          Goal {goalStatusLabel(props.goal.status)}
        </div>
        <div className="flex items-start gap-2">
          <h2 className="text-foreground flex-1 text-sm leading-5 font-semibold whitespace-pre-wrap">
            {props.goal.objective}
          </h2>
          {canEditObjective && (
            <button
              type="button"
              className="text-muted hover:text-foreground inline-flex shrink-0 items-center gap-1 text-xs underline"
              aria-label="Edit goal objective"
              onClick={(event) => openObjectiveEditor(event.currentTarget)}
            >
              <Pencil className="h-3 w-3" aria-hidden="true" />
              Edit
            </button>
          )}
        </div>
      </header>

      {isPendingPersistence && (
        <p className="border-border-light bg-surface-secondary text-muted rounded-md border p-3 text-sm leading-5">
          This goal is queued while the current stream finishes. It will become editable once it is
          saved.
        </p>
      )}

      {props.goal.status === "complete" && props.goal.completionSummary && (
        <section
          className="border-border-light bg-surface-secondary rounded-md border p-3"
          aria-label="Completion summary"
        >
          <h3 className="text-foreground mb-1 text-sm font-semibold">Completion summary</h3>
          <p className="text-muted text-sm leading-5">{props.goal.completionSummary}</p>
        </section>
      )}

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Cost</dt>
          <dd className="counter-nums text-foreground">{formatGoalCents(props.goal.costCents)}</dd>
        </div>
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Budget</dt>
          <dd className="counter-nums text-foreground flex items-center justify-between gap-2">
            <span>
              {props.goal.budgetCents == null
                ? "No budget"
                : formatGoalCents(props.goal.budgetCents)}
            </span>
            {canEdit && (
              <button
                type="button"
                className="text-muted hover:text-foreground text-xs underline"
                aria-label="Edit goal budget"
                onClick={(event) => openBudgetEditor(event.currentTarget)}
              >
                Edit
              </button>
            )}
          </dd>
        </div>
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Remaining</dt>
          <dd className="counter-nums text-foreground">
            {props.goal.budgetCents == null
              ? "—"
              : formatGoalCents(Math.max(0, props.goal.budgetCents - props.goal.costCents))}
          </dd>
        </div>
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Turns</dt>
          <dd className="counter-nums text-foreground flex items-center justify-between gap-2">
            <span>
              {props.goal.turnCap == null
                ? String(props.goal.turnsUsed)
                : `${props.goal.turnsUsed} / ${props.goal.turnCap}`}
            </span>
            {canEdit && (
              <button
                type="button"
                className="text-muted hover:text-foreground text-xs underline"
                aria-label="Edit goal turn cap"
                onClick={(event) => openTurnCapEditor(event.currentTarget)}
              >
                Edit
              </button>
            )}
          </dd>
        </div>
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Elapsed</dt>
          <dd className="counter-nums text-foreground">
            {formatGoalElapsed(props.goal.startedAtMs)}
          </dd>
        </div>
      </dl>

      {editingField === "objective" && (
        <div
          className="border-border-light bg-surface-secondary rounded-md border p-3"
          role="group"
          aria-label="Edit goal objective"
        >
          <label
            className="text-foreground mb-2 block text-sm font-medium"
            htmlFor="goal-objective-editor"
          >
            Objective
          </label>
          <textarea
            ref={objectiveInputRef}
            id="goal-objective-editor"
            className="border-border bg-surface-primary text-foreground focus:border-accent min-h-20 w-full rounded-md border p-2 text-sm outline-none"
            aria-label="Goal objective"
            value={editValue}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setEditValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeEditor();
              }
              // Submit on Cmd/Ctrl+Enter to avoid trapping users mid-paragraph
              // when they hit Enter for a newline.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submitEditor();
              }
            }}
          />
          <p className="text-muted mt-1 text-xs">
            Renames the current goal in place. Accounting and goal ID are preserved.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="bg-accent text-accent-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => void submitEditor()}
            >
              Save objective
            </button>
            <button
              type="button"
              className="border-border-light bg-surface-primary text-foreground rounded-md border px-3 py-1.5 text-sm"
              disabled={isSubmitting}
              onClick={closeEditor}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {(editingField === "budget" || editingField === "turnCap") && (
        <div
          className="border-border-light bg-surface-secondary rounded-md border p-3"
          role="group"
          aria-label={editingField === "budget" ? "Edit goal budget" : "Edit goal turn cap"}
        >
          <label
            className="text-foreground mb-2 block text-sm font-medium"
            htmlFor={`goal-${editingField}-editor`}
          >
            {editingField === "budget" ? "Budget" : "Turn cap"}
          </label>
          <input
            ref={editInputRef}
            id={`goal-${editingField}-editor`}
            className="border-border bg-surface-primary text-foreground focus:border-accent w-full rounded-md border p-2 text-sm outline-none"
            aria-label={editingField === "budget" ? "Goal budget amount" : "Goal turn cap"}
            value={editValue}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setEditValue(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeEditor();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void submitEditor();
              }
            }}
          />
          <p className="text-muted mt-1 text-xs">
            {editingField === "budget"
              ? "Use $5, 500c, 0, or blank for no budget."
              : "Use a positive whole number, or blank for no cap."}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="bg-accent text-accent-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => void submitEditor()}
            >
              {editingField === "budget" ? "Save budget" : "Save turn cap"}
            </button>
            <button
              type="button"
              className="border-border-light bg-surface-primary text-foreground rounded-md border px-3 py-1.5 text-sm"
              disabled={isSubmitting}
              onClick={closeEditor}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          {canPause && (
            <button
              type="button"
              className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary rounded-md border px-3 py-1.5 text-sm"
              aria-label="Pause goal"
              onClick={() => void setStatus("paused")}
            >
              Pause
            </button>
          )}
          {canResume && (
            <button
              type="button"
              className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary rounded-md border px-3 py-1.5 text-sm"
              aria-label="Resume goal"
              onClick={() => void setStatus("active")}
            >
              Resume
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary rounded-md border px-3 py-1.5 text-sm"
              aria-label="Mark goal complete"
              onClick={(event) => openSummaryInput(event.currentTarget)}
            >
              Mark complete
            </button>
          )}
        </div>
      )}

      {/*
        Clear is intentionally de-emphasized: completed goals already flow into
        the "Completed goals" list below via the backend's append-on-clear
        behavior, so the primary action after wrapping up is to start a new
        goal (via `/goal` or the command palette). The text link is kept for
        users who want to discard the current goal without a completion
        summary, but it must not compete visually with Pause / Resume / Mark
        complete. Gated on `canEdit` so transcript-only / pending-persistence
        goals do not expose a destructive action.
      */}
      {canEdit && (
        <div className="-mt-1 text-xs">
          <button
            type="button"
            className="text-muted hover:text-foreground underline"
            aria-label="Clear goal"
            onClick={() => void clearGoal()}
          >
            {props.goal.status === "complete" ? "Archive this goal" : "Clear goal"}
          </button>
        </div>
      )}

      {isSummaryInputOpen && (
        <div
          className="border-border-light bg-surface-secondary rounded-md border p-3"
          role="group"
          aria-label="Complete goal"
          onKeyDown={trapSummaryFocus}
        >
          <label
            className="text-foreground mb-2 block text-sm font-medium"
            htmlFor="goal-completion-summary"
          >
            Completion summary
          </label>
          <textarea
            ref={inputRef}
            id="goal-completion-summary"
            className="border-border bg-surface-primary text-foreground focus:border-accent min-h-20 w-full rounded-md border p-2 text-sm outline-none"
            aria-label="Goal completion summary"
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="bg-accent text-accent-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-60"
              disabled={isSubmitting}
              onClick={() => void submitSummary()}
            >
              Save summary
            </button>
            <button
              type="button"
              className="border-border-light bg-surface-primary text-foreground rounded-md border px-3 py-1.5 text-sm"
              disabled={isSubmitting}
              onClick={closeSummaryInput}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-danger-soft text-sm">{error}</p>}

      {filteredHistory.length > 0 && <GoalHistorySection entries={filteredHistory} />}
    </section>
  );
}

const END_REASON_LABELS = {
  completed: "Completed",
  cleared: "Cleared",
  replaced: "Replaced",
} as const;

interface GoalHistorySectionProps {
  entries: GoalHistoryEntry[];
}

function GoalHistorySection(props: GoalHistorySectionProps) {
  return (
    <section aria-label="Completed goals" className="flex flex-col gap-2">
      <h3 className="text-muted text-xs font-medium uppercase">
        Completed goals
        <span className="text-muted ml-1 lowercase">({props.entries.length})</span>
      </h3>
      <ul className="flex flex-col gap-1.5">
        {props.entries.map((entry) => (
          <GoalHistoryItem key={`${entry.goal.goalId}-${entry.endedAtMs}`} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

interface GoalHistoryItemProps {
  entry: GoalHistoryEntry;
}

function GoalHistoryItem(props: GoalHistoryItemProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { entry } = props;
  const { goal } = entry;
  const reasonLabel = END_REASON_LABELS[entry.endReason];
  // Old goals are intentionally read-only here: the spec is "old goals may
  // not be 'resumed' but the user may expand their card to see details".
  // Resume/Pause/Edit affordances are deliberately absent.

  return (
    <li className="border-border-light bg-surface-secondary rounded-md border">
      <button
        type="button"
        className="hover:bg-surface-tertiary flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs"
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} completed goal: ${goal.objective}`}
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        {isExpanded ? (
          <ChevronDown className="text-muted h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3 shrink-0" aria-hidden="true" />
        )}
        <span className="text-foreground line-clamp-1 flex-1 font-medium">{goal.objective}</span>
        <span className="text-muted counter-nums shrink-0">
          {formatGoalCents(goal.costCents)} · {goal.turnsUsed}t
        </span>
        <span className="text-muted shrink-0 tracking-wide uppercase">{reasonLabel}</span>
      </button>
      {isExpanded && (
        <div className="border-border-light border-t px-2.5 py-2 text-xs">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
            <div>
              <dt className="text-muted">Final status</dt>
              <dd className="text-foreground">{goalStatusLabel(goal.status)}</dd>
            </div>
            <div>
              <dt className="text-muted">Ended</dt>
              <dd className="text-foreground">{formatTimestamp(entry.endedAtMs)}</dd>
            </div>
            <div>
              <dt className="text-muted">Cost</dt>
              <dd className="counter-nums text-foreground">{formatGoalCents(goal.costCents)}</dd>
            </div>
            <div>
              <dt className="text-muted">Budget</dt>
              <dd className="counter-nums text-foreground">
                {goal.budgetCents == null ? "No budget" : formatGoalCents(goal.budgetCents)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Turns</dt>
              <dd className="counter-nums text-foreground">
                {goal.turnCap == null
                  ? String(goal.turnsUsed)
                  : `${goal.turnsUsed} / ${goal.turnCap}`}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Duration</dt>
              <dd className="counter-nums text-foreground">
                {formatGoalElapsed(goal.createdAtMs, entry.endedAtMs)}
              </dd>
            </div>
          </dl>
          {goal.completionSummary && (
            <div className="mt-2">
              <dt className="text-muted">Completion summary</dt>
              <dd className="text-foreground whitespace-pre-wrap">{goal.completionSummary}</dd>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function formatTimestamp(ms: number): string {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toISOString();
  }
}
