import { Pencil, Settings2, Target } from "lucide-react";
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  goalActiveMode,
  isGoalLifecycleActive,
  isGoalPendingPersistence,
  type GoalHistoryEntry,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import {
  parseGoalBudgetInputCents,
  parseGoalTurnCapInput,
} from "@/common/utils/goals/budgetParser";
import { APIContext } from "@/browser/contexts/API";
import { useGoalDefaults } from "@/browser/utils/goals/useGoalDefaults";
import { cn } from "@/common/lib/utils";
// Import shared formatters / status labels from goalToolUtils so the GoalTab
// stays in sync with the tool-call cards (Coder-agents-review nits DEREM-28
// + DEREM-29). Local copies drifted in case (`active` vs `Active`) and could
// drift further as Goal status grows.
import { formatGoalElapsed, goalStatusLabel } from "@/browser/features/Tools/Goal/goalToolUtils";
import { GoalDefaultsModal } from "@/browser/features/RightSidebar/GoalDefaultsModal";
import { GoalBoardSections } from "@/browser/features/RightSidebar/GoalBoardSections";
import { useGoalBoard } from "@/browser/features/RightSidebar/useGoalBoard";

/**
 * Inputs accepted by the in-tab "Set goal" form. Mirrors the slash-command
 * `goal-set` shape (objective + optional budget + optional turn cap) so the
 * UI and `/goal` paths agree on the create vocabulary. `budgetCents` is a
 * tri-state: `undefined` means "apply default", `null`/`0` means "no
 * budget", and a positive number is an explicit cents value.
 */
export interface GoalCreateIntent {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
}

interface GoalTabProps {
  /**
   * Workspace this tab is bound to. Required by the in-tab `GoalDefaultsModal`
   * which reads + writes the per-workspace override of the global
   * `goalDefaults` block; optional for the rest of the tab so existing
   * read-only stories don't break.
   */
  workspaceId?: string;
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
  /**
   * Create a brand-new goal for the workspace. Used by the empty-state form
   * and the "Replace goal" button on the current-goal card. Optional so
   * read-only storybook stories can omit it. Slash-command parity: same
   * fields as `/goal <objective> [--budget …] [--turns …]`.
   */
  onCreate?: (intent: GoalCreateIntent) => Promise<void> | void;
}

// `parseBudgetInput` is now a thin alias for the canonical parser shared
// with the slash command and the command palette (Coder-agents-review P3
// DEREM-21).
const parseBudgetInput = parseGoalBudgetInputCents;

// Alias kept for callsite stability; canonical parser lives next to
// `parseGoalBudgetInputCents` so every entry point validates the same way
// (Codex P2 follow-up — partial-int inputs like `1.5` / `12abc` are
// rejected here instead of silently truncating).
const parseTurnCapInput = parseGoalTurnCapInput;

type EditingField = "objective" | "budget" | "turnCap";

export function GoalTab(props: GoalTabProps) {
  const [isSummaryInputOpen, setIsSummaryInputOpen] = useState(false);
  const [editingField, setEditingField] = useState<EditingField | null>(null);
  const [editValue, setEditValue] = useState("");
  const [summary, setSummary] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The "Change defaults" link in both the empty-state create form and
  // the active-goal action row opens this modal. Kept at the tab level
  // so a single instance covers both surfaces — opening from either
  // closes any other.
  const [isDefaultsModalOpen, setIsDefaultsModalOpen] = useState(false);
  // Same opt-in API context pattern as `useGoalDefaults` / `useGoalBoard`:
  // tolerate being mounted outside an `APIProvider` (storybook stories
  // render the GoalTab in isolation) by reading the context directly.
  // The Archive-on-complete handler short-circuits when `api` is null.
  const apiContext = useContext(APIContext);
  const api = apiContext?.api ?? null;
  // Goal-board state lives here so both the empty-state and active-goal
  // branches can render the Upcoming / Completed / Archived sections.
  // Mutations route through `refreshBoard` so the renderer re-reads after
  // a queue/archive/revive/promote/reorder.
  //
  // `activeGoalKey` carries the parent's view of the active goal so the
  // hook also re-fetches when setGoal/clearGoal mutates the active slot
  // (Codex P2: 'Refresh the board after auto-promotion'). Without this,
  // marking the active goal complete would update the header but leave
  // the board's Upcoming list stale until another board mutation.
  const activeGoalKey = props.goal ? `${props.goal.goalId}:${props.goal.status}` : null;
  const { board, refresh: refreshBoard } = useGoalBoard(props.workspaceId, activeGoalKey);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const objectiveInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const lastCompleteInputRequestRef = useRef(props.openCompleteInputRequest ?? 0);

  // Completed goals stay editable so the user can revive a goal the agent
  // declared done too eagerly. The only hard gate is pending-persistence
  // (mid-stream queued goal): writes would otherwise race the stream-end
  // commit. Backend pairs with this — see
  // workspaceGoalService.validateStatusTransition which only blocks
  // non-user initiators from leaving `complete`.
  const canEditObjective =
    props.goal != null && !isGoalPendingPersistence(props.goal) && props.onUpdateObjective != null;

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

  // The inline objective editor *replaces* the Edit button in the header
  // while editing, so the `originRef` we captured in `openObjectiveEditor`
  // points to a detached DOM node by the time `closeEditor` calls
  // `.focus()` — the focus restore silently no-ops. Defer focus to the
  // re-rendered button by querying for it via aria-label once
  // `editingField` transitions back to null after an objective edit. The
  // budget / turn-cap editors don't have this problem because their
  // Edit buttons stay mounted (the editor is a separate panel further
  // down the tab).
  const previousEditingFieldRef = useRef<EditingField | null>(null);
  useEffect(() => {
    if (previousEditingFieldRef.current === "objective" && editingField === null) {
      const opener = document.querySelector<HTMLElement>(
        'button[aria-label="Edit goal objective"]'
      );
      opener?.focus();
    }
    previousEditingFieldRef.current = editingField;
  }, [editingField]);

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

  // The legacy `props.history` is still passed in for back-compat with
  // older callers but is no longer rendered here — completed + archived
  // goals are now sourced from the goal-board (`useGoalBoard` above),
  // which reads the same `goal-history.jsonl`. We deliberately do
  // nothing with `props.history` in this branch; remove from the
  // `GoalTabProps` interface when no callers still pass it.

  if (!props.goal) {
    return (
      <section
        className="flex h-full flex-col gap-4 overflow-y-auto p-4"
        aria-label="Workspace goal"
      >
        {props.onCreate ? (
          // Empty-state primary action: a goal-creation form with full
          // slash-command parity (objective + optional budget + optional
          // turn cap). Replaces the previous "No goal is set" placeholder
          // — the placeholder is folded into the form's helper text so
          // users don't need to know about `/goal` to start one.
          <GoalCreateForm onCreate={props.onCreate} workspaceId={props.workspaceId} />
        ) : (
          <div className="text-muted border-border-light flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6 text-center text-sm">
            <Target className="h-5 w-5" aria-hidden="true" />
            <p>No goal is set for this workspace.</p>
          </div>
        )}
        {/*
          The board (Upcoming / Completed / Archived) lives below the
          empty-state form so a returning user can still see goals they
          completed or archived in this workspace. Active is the form
          itself in this branch.
        */}
        {props.workspaceId != null && (
          <GoalBoardSections
            workspaceId={props.workspaceId}
            board={board}
            onMutated={refreshBoard}
          />
        )}
      </section>
    );
  }

  const isPendingPersistence = isGoalPendingPersistence(props.goal);
  const canEdit = !isPendingPersistence;
  const lifecycle = isGoalLifecycleActive(props.goal.status) ? "active" : "complete";
  const activeMode = goalActiveMode(props.goal.status);
  // Pause / Resume now operate on the active goal's sub-mode rather than a
  // peer status. Resume covers both "user paused → resume" and
  // "completed → reopen" (the backend allows user-initiated revives out
  // of `complete`; see workspaceGoalService.validateStatusTransition).
  const canPause = canEdit && activeMode === "running";
  const canResume = canEdit && (activeMode === "paused" || lifecycle === "complete");
  // Mark-complete mirrors backend `validateStatusTransition` exactly:
  // only `active` (running) and `budget_limited` are valid sources for
  // the complete transition. Paused goals must be resumed first; this
  // matches the slash command + palette gating.
  const canComplete = canEdit && (activeMode === "running" || activeMode === "budget_limited");

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

  // Accent-green styling when the goal is lifecycle-active: the panel
  // header should communicate "this is the active goal" at a glance,
  // visually distinct from the muted "Set a goal" empty-state form.
  // Sub-status (paused / budget-limited) shifts the label text but keeps
  // the green band so the user sees the lifecycle, not the mode.
  const headerToneClass =
    lifecycle === "active"
      ? "border-success/40 bg-success/5"
      : "border-border-light bg-surface-secondary";
  const headerLabelClass = lifecycle === "active" ? "text-success" : "text-muted";

  return (
    <section className="flex h-full flex-col gap-4 overflow-y-auto p-4" aria-label="Workspace goal">
      <header className={cn("rounded-md border p-3", headerToneClass)}>
        <div
          className={cn(
            "mb-1 flex items-center gap-1.5 text-xs font-medium uppercase",
            headerLabelClass
          )}
        >
          <Target className="h-3.5 w-3.5" aria-hidden="true" />
          {goalStatusLabel(props.goal.status)}
        </div>
        {editingField === "objective" ? (
          // Inline objective editor: replaces the h2 in place rather than
          // hopping the editor down to a separate panel further down the
          // tab (which previously made the cursor target jump on click).
          // Cmd/Ctrl+Enter submits, plain Enter inserts a newline.
          <div className="flex flex-col gap-2">
            <textarea
              ref={objectiveInputRef}
              id="goal-objective-editor"
              aria-label="Goal objective"
              className="border-border bg-surface-primary text-foreground focus:border-accent min-h-20 w-full rounded-md border p-2 text-sm leading-5 font-semibold outline-none"
              value={editValue}
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setEditValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                }
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitEditor();
                }
              }}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="bg-accent text-accent-foreground rounded-md px-3 py-1 text-xs font-medium disabled:opacity-60"
                disabled={isSubmitting}
                onClick={() => void submitEditor()}
              >
                Save
              </button>
              <button
                type="button"
                className="border-border-light bg-surface-primary text-foreground rounded-md border px-3 py-1 text-xs"
                disabled={isSubmitting}
                onClick={closeEditor}
              >
                Cancel
              </button>
              <span className="text-muted ml-auto text-[10px]">
                Renames in place — accounting and goal ID are preserved.
              </span>
            </div>
          </div>
        ) : (
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
        )}
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

      {/* Objective editing is now inline inside the header above; the
          standalone editor panel was removed so the cursor stays where
          the user clicked (Codex P3 UX review). */}

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
              aria-label={lifecycle === "complete" ? "Reopen goal" : "Resume goal"}
              onClick={() => void setStatus("active")}
            >
              {/* "Reopen" reads better than "Resume" when the goal was
                  marked complete — the user is reviving a goal the
                  agent decided was done, not resuming a paused one. */}
              {lifecycle === "complete" ? "Reopen" : "Resume"}
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
            aria-label={lifecycle === "complete" ? "Archive goal" : "Clear goal"}
            onClick={() => {
              // Codex P3: when the active goal is complete, the user-
              // visible "Archive this goal" label needs to land in the
              // Archived board section. The legacy `clearGoal()` path
              // records an `endReason: "completed"` history entry, so
              // it would land in Completed instead. Route to the new
              // `archiveGoal` endpoint for complete goals; everything
              // else still uses `clearGoal()`.
              if (lifecycle === "complete" && api && props.goal) {
                void api.workspace
                  .archiveGoal({
                    workspaceId: props.workspaceId ?? "",
                    goalId: props.goal.goalId,
                  })
                  .then(() => refreshBoard())
                  .catch(() => {
                    /* swallow; UI stays at the current state */
                  });
              } else {
                void clearGoal();
              }
            }}
          >
            {lifecycle === "complete" ? "Archive this goal" : "Clear goal"}
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

      {/*
        The legacy filteredHistory list is no longer rendered here —
        completed + archived goals show up inside the board's Completed
        and Archived sections below. The board reads the same history
        file, so nothing is lost.
      */}

      {props.workspaceId != null && (
        <>
          <GoalBoardSections
            workspaceId={props.workspaceId}
            board={board}
            onMutated={refreshBoard}
          />
          {/* "Change defaults" is the long-lived home for goal-defaults
              config now — opens the modal that lets the user override
              defaults for this workspace OR change the global defaults.
              The link is muted so it doesn't compete with Pause / Resume
              / Mark complete above. */}
          <div className="mt-1 text-xs">
            <button
              type="button"
              className="text-muted hover:text-foreground inline-flex items-center gap-1 underline"
              aria-label="Change goal defaults"
              onClick={() => setIsDefaultsModalOpen(true)}
            >
              <Settings2 className="h-3 w-3" aria-hidden="true" />
              Change defaults
            </button>
          </div>
          <GoalDefaultsModal
            workspaceId={props.workspaceId}
            open={isDefaultsModalOpen}
            onOpenChange={setIsDefaultsModalOpen}
          />
        </>
      )}
    </section>
  );
}

interface GoalCreateFormProps {
  onCreate: (intent: GoalCreateIntent) => Promise<void> | void;
  workspaceId?: string;
}

/**
 * In-tab "Set goal" form. Mirrors the slash command's `goal-set` shape:
 *
 *   /goal <objective> [--budget $5|500c|--no-budget] [--turns N]
 *
 * Budget and turn-cap inputs reuse the same parsers (`parseBudgetInput`,
 * `parseTurnCapInput`) as the inline budget / turn-cap editors so the
 * accepted vocabulary is identical across all surfaces (slash, palette,
 * tab). A blank budget defers to `goalDefaults` upstream (which is what
 * `loadGoalDefaults` + `resolveGoalSetIntent` apply in the parent
 * handler), so the form intentionally distinguishes "blank" (defer) from
 * "0 / no budget" (explicit clear) by leaving the budget field optional
 * and only emitting `budgetCents` when the user typed something.
 */
function GoalCreateForm(props: GoalCreateFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Defaults modal is per-form because the empty-state lives outside the
  // active-goal branch's modal state; sharing would require lifting more
  // state up than is justified here.
  const [isDefaultsModalOpen, setIsDefaultsModalOpen] = useState(false);
  // Pre-fill Budget / Turn cap with the workspace's effective defaults
  // (global config + per-workspace override) so the user can see what
  // they'd get and edit only when they need to. `reload()` is wired
  // through the defaults modal so a saved change updates the placeholders
  // in real time.
  const { defaults, reload: reloadDefaults } = useGoalDefaults(props.workspaceId);
  // Refs (instead of controlled state) for the same reason the inline
  // budget / turn-cap editors use them: a single source of truth at submit
  // time avoids stale-closure / test-timing surprises and matches the
  // pattern users already see elsewhere in the GoalTab.
  const objectiveRef = useRef<HTMLTextAreaElement | null>(null);
  const budgetRef = useRef<HTMLInputElement | null>(null);
  const turnCapRef = useRef<HTMLInputElement | null>(null);

  // Effective defaults shown as placeholder text. We seed the inputs with
  // `defaultValue` rather than `value` so the user can clear them; the
  // placeholder mirrors what would be applied if the field is left blank.
  //
  // Codex P2: when `alwaysRequireExplicitBudget` is OFF, a blank budget
  // is intentionally resolved to `null` (no budget) by
  // `resolveGoalSetIntent`, not to `defaultBudgetCents`. The placeholder
  // must match that resolution or the form misrepresents what a blank
  // submission will do.
  const budgetPlaceholder = defaults.alwaysRequireExplicitBudget
    ? `$${(defaults.defaultBudgetCents / 100).toFixed(2)} (default)`
    : "no budget (default)";
  const turnCapPlaceholder =
    defaults.defaultTurnCap == null ? "no cap (default)" : `${defaults.defaultTurnCap} (default)`;

  const submit = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const trimmedObjective = (objectiveRef.current?.value ?? "").trim();
      if (trimmedObjective.length === 0) {
        setError("Goal objective is required.");
        objectiveRef.current?.focus();
        return;
      }

      const intent: GoalCreateIntent = { objective: trimmedObjective };

      // Budget: leave omitted when blank so the parent handler can apply
      // `goalDefaults.defaultBudgetCents` (matching the palette / slash
      // path). Explicit `0` or "no budget" wording flows through
      // `parseBudgetInput` and lands as `null` ("explicit clear"), again
      // matching the slash `--no-budget` flag.
      const budgetRaw = (budgetRef.current?.value ?? "").trim();
      if (budgetRaw.length > 0) {
        const budgetCents = parseBudgetInput(budgetRaw);
        if (budgetCents === undefined) {
          setError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
          return;
        }
        intent.budgetCents = budgetCents;
      }

      // Turn cap: same tri-state rules — blank defers to defaults, a
      // positive integer is explicit, anything else is rejected. The slash
      // command rejects non-positive values too (see `parseGoalTurnCap`).
      const turnCapRaw = (turnCapRef.current?.value ?? "").trim();
      if (turnCapRaw.length > 0) {
        const parsedTurnCap = parseTurnCapInput(turnCapRaw);
        if (parsedTurnCap === undefined) {
          setError("Enter a positive whole-number turn cap, or leave blank for no cap.");
          return;
        }
        intent.turnCap = parsedTurnCap;
      }

      await props.onCreate(intent);
      // Clear the form on success so a returning user sees a blank slate
      // (if for some reason the goal didn't take, e.g., the workspace
      // emitted `goal_conflict` after retry). The parent's `goal`
      // becoming non-null is what actually unmounts the form.
      if (objectiveRef.current) objectiveRef.current.value = "";
      if (budgetRef.current) budgetRef.current.value = "";
      if (turnCapRef.current) turnCapRef.current.value = "";
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Goal creation failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className="border-border-light bg-surface-secondary flex flex-col gap-3 rounded-md border p-3"
      aria-label="Create workspace goal"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="text-muted flex items-center gap-1.5 text-xs font-medium uppercase">
        <Target className="h-3.5 w-3.5" aria-hidden="true" />
        Set a goal
      </div>
      <p className="text-muted text-xs leading-5">
        Describe what success looks like. Equivalent to{" "}
        <code className="font-mono">/goal &lt;objective&gt;</code> in chat.
      </p>

      <div className="flex flex-col gap-1">
        <label className="text-foreground text-sm font-medium" htmlFor="goal-create-objective">
          Objective
        </label>
        <textarea
          ref={objectiveRef}
          id="goal-create-objective"
          className="border-border bg-surface-primary text-foreground focus:border-accent min-h-20 w-full rounded-md border p-2 text-sm outline-none"
          aria-label="Goal objective"
          placeholder="Ship the goal lifecycle slice"
          defaultValue=""
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter mirrors the inline objective editor so users
            // who already learned that gesture don't have to relearn it
            // here. Plain Enter intentionally inserts a newline (Codex
            // tip carousel says "Goals can be multiple lines").
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-foreground text-sm font-medium" htmlFor="goal-create-budget">
            Budget <span className="text-muted text-xs font-normal">(optional)</span>
          </label>
          <input
            ref={budgetRef}
            id="goal-create-budget"
            className="border-border bg-surface-primary text-foreground focus:border-accent w-full rounded-md border p-2 text-sm outline-none"
            aria-label="Goal budget"
            placeholder={budgetPlaceholder}
            defaultValue=""
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-foreground text-sm font-medium" htmlFor="goal-create-turncap">
            Turn cap <span className="text-muted text-xs font-normal">(optional)</span>
          </label>
          <input
            ref={turnCapRef}
            id="goal-create-turncap"
            className="border-border bg-surface-primary text-foreground focus:border-accent w-full rounded-md border p-2 text-sm outline-none"
            aria-label="Goal turn cap"
            placeholder={turnCapPlaceholder}
            inputMode="numeric"
            defaultValue=""
          />
        </div>
      </div>

      {props.workspaceId != null && (
        <div className="text-muted -mt-1 flex items-center justify-between text-[11px]">
          <span>
            {defaults.alwaysRequireExplicitBudget
              ? "Leave Budget / Turn cap blank to use the defaults shown above."
              : "Leave Budget blank to create an unbudgeted goal; Turn cap blank uses the default shown above."}
          </span>
          <button
            type="button"
            className="hover:text-foreground inline-flex items-center gap-1 underline"
            aria-label="Change goal defaults"
            onClick={() => setIsDefaultsModalOpen(true)}
          >
            <Settings2 className="h-3 w-3" aria-hidden="true" />
            Change defaults
          </button>
        </div>
      )}

      {error && (
        <p className="text-danger-soft text-sm" role="alert">
          {error}
        </p>
      )}

      <div>
        <button
          type="submit"
          className="bg-accent text-accent-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-60"
          disabled={isSubmitting}
          aria-label="Set goal"
        >
          {isSubmitting ? "Setting goal…" : "Set goal"}
        </button>
      </div>
      {props.workspaceId != null && (
        <GoalDefaultsModal
          workspaceId={props.workspaceId}
          open={isDefaultsModalOpen}
          onOpenChange={setIsDefaultsModalOpen}
          onPersist={reloadDefaults}
        />
      )}
    </form>
  );
}

// Completed-goal rendering moved into `GoalBoardSections` as part of the
// multi-goal queue. The previous `GoalHistorySection` / `GoalHistoryItem`
// / `formatTimestamp` helpers are no longer needed here — the board
// reads the same `goal-history.jsonl` and surfaces completed goals
// under its Completed section with consistent styling alongside
// Upcoming and Archived.
