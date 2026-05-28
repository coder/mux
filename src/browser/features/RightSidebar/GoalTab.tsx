import {
  CheckCircle2,
  Inbox,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Settings2,
  Target,
  Trash2,
} from "lucide-react";
import { useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  goalActiveMode,
  isGoalLifecycleActive,
  isGoalPendingPersistence,
  type GoalSnapshot,
  type GoalStatus,
} from "@/common/types/goal";
import { GOAL_OBJECTIVE_PLACEHOLDER } from "@/constants/goals";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import {
  parseGoalBudgetInputCents,
  parseGoalTurnCapInput,
} from "@/common/utils/goals/budgetParser";
import {
  AUTO_COMPACTION_THRESHOLD_MAX,
  AUTO_COMPACTION_THRESHOLD_MIN,
  DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
} from "@/common/constants/ui";
import { APIContext } from "@/browser/contexts/API";
import { useGoalDefaults } from "@/browser/utils/goals/useGoalDefaults";
import { cn } from "@/common/lib/utils";
// Import shared formatters / status labels so the GoalTab stays in sync with
// the tool-call cards as goal status labels evolve.
import { formatGoalElapsed, goalStatusLabel } from "@/browser/features/Tools/Goal/goalToolUtils";
import { GoalDefaultsModal } from "@/browser/features/RightSidebar/GoalDefaultsModal";
import {
  GoalBoardSections,
  RowActionButton,
} from "@/browser/features/RightSidebar/GoalBoardSections";
import { useGoalBoard } from "@/browser/features/RightSidebar/useGoalBoard";

/**
 * Inputs accepted by the in-tab "Set goal" form. Mirrors the slash-command
 * `goal-set` shape (objective + optional budget + optional turn cap) so the
 * UI and `/goal` paths agree on the create vocabulary. `budgetCents` is a
 * tri-state: `undefined` means "apply default", `null`/`0` means "no
 * budget", and a positive number is an explicit cents value.
 *
 * `autoCompactionThresholdPct` follows the same tri-state shape:
 *   - `undefined` → no override; the workspace's per-model slider applies.
 *   - `null` → explicit clear of an existing override.
 *   - integer 0–100 → percent of context window at which to compact
 *     (`100` = compaction disabled specifically for this goal).
 */
export interface GoalCreateIntent {
  objective: string;
  budgetCents?: number | null;
  turnCap?: number | null;
  autoCompactionThresholdPct?: number | null;
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
  openCompleteInputRequest?: number;
  // GoalTab UI only invokes user-facing transitions (pause/resume/complete);
  // `budget_limited` is internal-only and is excluded from the public oRPC
  // `setGoal` input shape.
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
  /**
   * Persist a change to the goal's per-goal auto-compact override. `null`
   * clears the override (the workspace's per-model slider applies again);
   * a number 0–100 sets the percent. Optional so read-only storybook
   * stories can omit it (they hide the Edit affordance via `canEdit`).
   */
  onUpdateAutoCompactionThresholdPct?: (pct: number | null) => Promise<void> | void;
  onClear?: () => Promise<void> | void;
  /**
   * Create a brand-new goal for the workspace. Used by the empty-state form
   * and the "Replace goal" button on the current-goal card. Optional so
   * read-only storybook stories can omit it. Slash-command parity: same
   * fields as `/goal <objective> [--budget …] [--turns …]`.
   */
  onCreate?: (intent: GoalCreateIntent) => Promise<void> | void;
}

// Aliases kept for callsite stability; canonical parsers live next to the
// slash-command path so every entry point validates the same way.
const parseBudgetInput = parseGoalBudgetInputCents;
const parseTurnCapInput = parseGoalTurnCapInput;

type EditingField = "objective" | "budget" | "turnCap";

/**
 * Sentinel "this goal opts out of auto-compaction" value. Mirrors the
 * workspace per-model slider, which uses `100` as the disabled marker —
 * keeping the encoding identical means the renderer banner, the goal
 * record, and the compaction monitor all share one disable rule.
 */
const PER_GOAL_COMPACT_DISABLED_PCT = 100;

/**
 * Snap a raw slider position (0–100) into the persisted-percent
 * vocabulary the goal record uses:
 *   - dragging at or past `100 - one-step-of-headroom` → `100` (Off /
 *     per-goal disabled). Same "drag to the right end disables" behavior
 *     the workspace per-model slider uses.
 *   - everything else clamps into `[MIN, MAX]` and snaps to 5%
 *     increments, matching the workspace slider's grid so values
 *     entered here look like values entered there.
 */
function snapAutoCompactSliderValue(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT;
  if (raw >= PER_GOAL_COMPACT_DISABLED_PCT) return PER_GOAL_COMPACT_DISABLED_PCT;
  const clamped = Math.max(
    AUTO_COMPACTION_THRESHOLD_MIN,
    Math.min(AUTO_COMPACTION_THRESHOLD_MAX, raw)
  );
  return Math.round(clamped / 5) * 5;
}

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
  // hook re-fetches when setGoal/clearGoal mutates the active slot.
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
  // `.focus` — the focus restore silently no-ops. Defer focus to the
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

  // Header tone keys off `activeMode` (not just lifecycle) so the user
  // can tell at a glance whether the active goal is actually progressing
  // (`running` → success/green) or stalled waiting for them (`paused` /
  // `budget_limited` → warning/amber). Complete + read-only fall back to
  // the muted surface tone. Amber consistently means "lifecycle-active
  // but not auto-running" across the header band, the lifecycle status
  // badge (`GoalStatusBadge` in `goalToolUtils.tsx`), and the sidebar
  // tab label accent so the cue is reinforced wherever the workspace's
  // goal status surfaces.
  const isStalledActive = activeMode === "paused" || activeMode === "budget_limited";
  const headerToneClass =
    activeMode === "running"
      ? "border-success/40 bg-success/5"
      : isStalledActive
        ? "border-warning/40 bg-warning-overlay"
        : "border-border-light bg-surface-secondary";
  const headerLabelClass =
    activeMode === "running" ? "text-success" : isStalledActive ? "text-warning" : "text-muted";

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

      {/*
        Stat tiles. Previously this was a 5-cell 2-col grid where Cost,
        Budget, and Remaining each lived in their own tile, which meant
        the user had to mentally re-assemble "I've spent $1.25 of $5.00
        so $3.75 is left" from three corners of the panel. Worse, the
        Turn cap was only surfaced when explicitly set — a missing cap
        rendered as bare turn count, indistinguishable from "no cap set
        yet" vs "cap is just way above current usage". You had to click
        Edit to find out.

        Layout now consolidates by metric so each card answers a single
        question:

          • Budget: "Have I run out of money yet?" — cost / cap with
            remaining + a thin progress bar. Full-width at narrow widths
            so the cost / remaining pair stays on one line; compresses
            into a 1/3-width tile at wider widths where its internal
            copy stacks vertically (see `BudgetTile`).
          • Turns: "Have I run out of turns yet?" — always shows
            turns / cap (or `no cap`).
          • Auto-compact: "When will this goal compact?" — embedded
            slider, "Default" mode when no per-goal override is set.
          • Elapsed: wall-clock time, shown as a thin full-width row
            at wider widths so it doesn't compete with the three
            decision-driving tiles above.

        Container queries (`[container-type:inline-size]` + `@md:`)
        scale the grid from 2 cols (narrow) to 3 cols (wider) so that,
        as the sidebar is resized, Budget / Turn cap / Auto-compact
        line up on one row exactly the way the user asked for. Per
        `AGENTS.md`, the sidebar is dynamically resizable, so a viewport
        breakpoint (`sm:` / `md:`) wouldn't have worked here.

        Edit affordances stay on each tile (same aria-labels as before)
        so the inline editor path is untouched.
      */}
      <dl className="@container [container-type:inline-size] grid grid-cols-2 gap-2 text-sm @md:grid-cols-3">
        <BudgetTile
          costCents={props.goal.costCents}
          budgetCents={props.goal.budgetCents}
          canEdit={canEdit}
          onEdit={(event) => openBudgetEditor(event.currentTarget)}
        />
        <TurnsTile
          turnsUsed={props.goal.turnsUsed}
          turnCap={props.goal.turnCap}
          canEdit={canEdit}
          onEdit={(event) => openTurnCapEditor(event.currentTarget)}
        />
        {/* Auto-compact override (per-goal). When the goal has no
            override, the tile renders a "Default — workspace setting"
            row with a `Customize` button. Clicking Customize commits an
            override at the global default (70%) so the slider has a
            concrete value to drag from; from there the slider commits
            on release. `Use default` clears back to null. Sized as a
            tile peer to Turns/Elapsed at wider widths; spans both
            columns at narrow widths so the slider has room to breathe. */}
        <GoalAutoCompactSlider
          value={props.goal.autoCompactionThresholdPct ?? null}
          canEdit={canEdit && props.onUpdateAutoCompactionThresholdPct != null}
          onChange={(pct) => props.onUpdateAutoCompactionThresholdPct?.(pct)}
        />
        <div className="bg-surface-secondary rounded-md p-3 @md:col-span-3 @md:flex @md:items-baseline @md:justify-between @md:gap-3">
          <dt className="text-muted text-xs">Elapsed</dt>
          <dd className="counter-nums text-foreground mt-1 text-base leading-tight font-medium @md:mt-0">
            {formatGoalElapsed(props.goal.startedAtMs)}
          </dd>
        </div>
      </dl>

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
            inputMode={editingField === "turnCap" ? "numeric" : undefined}
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
              className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              aria-label="Pause goal"
              onClick={() => void setStatus("paused")}
            >
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              Pause
            </button>
          )}
          {/* For paused (lifecycle-active) goals, Resume is the obvious
              recovery action and keeps its green-tinted "primary" look.
              The lifecycle === "complete" path renders Reopen + Archive
              in their own branch below where Archive is the primary and
              Reopen is the secondary, so we exclude that case here to
              avoid double-rendering Reopen. */}
          {canResume && lifecycle !== "complete" && (
            <button
              type="button"
              className="border-success/40 bg-success/10 text-success hover:bg-success/20 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              aria-label="Resume goal"
              onClick={() => void setStatus("active")}
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              Resume
            </button>
          )}
          {canComplete && (
            <button
              type="button"
              className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              aria-label="Mark goal complete"
              onClick={(event) => openSummaryInput(event.currentTarget)}
            >
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              Mark complete
            </button>
          )}
          {/* Completed-goal action pair: Reopen on the left as the
              de-emphasized secondary (only reach for it if the agent
              declared done too eagerly), Archive on the right as the
              accent-colored primary because filing a finished goal is
              the obvious next step. Both buttons are sized like the rest
              of the action row (`px-3 py-1.5 text-sm`) so they read as
              peers, not as a chip-style afterthought. */}
          {lifecycle === "complete" && (
            <>
              <button
                type="button"
                className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
                aria-label="Reopen goal"
                onClick={() => void setStatus("active")}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                Reopen
              </button>
              <button
                type="button"
                className="bg-accent text-accent-foreground hover:bg-accent-dark inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm"
                aria-label="Archive goal"
                onClick={() => {
                  // Route through `archiveGoal` so the goal lands in the
                  // Archived board section instead of the legacy
                  // `clearGoal` path (which would record an
                  // `endReason: "completed"` history entry and land it in
                  // Completed). `refreshBoard` is the same nudge the row
                  // Archive button in `CompletedSection` uses.
                  if (api && props.goal) {
                    void api.workspace
                      .archiveGoal({
                        workspaceId: props.workspaceId ?? "",
                        goalId: props.goal.goalId,
                      })
                      .then(() => refreshBoard())
                      .catch(() => {
                        /* swallow; UI stays at the current state */
                      });
                  }
                }}
              >
                <Inbox className="h-3.5 w-3.5" aria-hidden="true" />
                Archive
              </button>
            </>
          )}
        </div>
      )}

      {/* Clear stays as a small de-emphasized chip below the main row
          for lifecycle-active goals, where the goal is still in flight
          and clearing it is destructive. For completed goals, Archive
          (above) replaces this surface. Gated on `canEdit` so
          transcript-only / pending-persistence goals do not expose a
          destructive action. */}
      {canEdit && lifecycle !== "complete" && (
        <div className="-mt-1">
          <RowActionButton aria-label="Clear goal" onClick={() => void clearGoal()}>
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            Clear goal
          </RowActionButton>
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

interface BudgetTileProps {
  costCents: number;
  budgetCents: number | null;
  canEdit: boolean;
  onEdit: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Cost / Budget / Remaining as a single tile. Consolidates the three
 * pre-existing standalone tiles so a quick glance answers "how much of
 * my budget have I used and how much is left". Layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │ Budget                          Edit │
 *   │ $1.25 of $5.00         $3.75 left    │
 *   │ ████░░░░░░░░░░░░░░░░░░░░░░░░░░░░     │
 *   └──────────────────────────────────────┘
 *
 * • Numeric pieces (`$1.25`, `$5.00`, `$3.75`) are wrapped in their own
 *   `<span>` so existing `getByText("$1.25")`-style asserts still match.
 * • `counter-nums` is the semantic tabular-numeral utility (per AGENTS.md
 *   styling guidance) — prevents jitter as `costCents` increments mid-
 *   stream.
 * • The progress bar uses `role="progressbar"` + `aria-valuetext` so
 *   screen readers get the same info sighted users do.
 * • When `budgetCents == null` the bar collapses and the secondary line
 *   shows "no budget" — the tile is then a single-value Cost card.
 */
function BudgetTile(props: BudgetTileProps) {
  // `status` is intentionally unread — the lifecycle's
  // `budget_limited` state can be triggered by EITHER hitting the
  // budget OR hitting the turn cap (see `hasReachedAnyLimit` in
  // `workspaceGoalService.ts`). If we OR'd `status === "budget_limited"`
  // into `overBudget`, a goal like cost `$1.25 of $5.00` with turns
  // `10 / 10` would lie ("$0.00 over") about the money. Base the
  // budget-tile "over" branch strictly on the budget numbers.
  const { costCents, budgetCents, canEdit, onEdit } = props;
  const hasBudget = budgetCents != null;
  // Reserve the "over" copy for strict inequality. At exact equality,
  // show "$0.00 left" while the bar fill / danger color still flags that
  // the cap has been reached.
  const overBudget = hasBudget && costCents > budgetCents;
  const atOrOverBudget = hasBudget && costCents >= budgetCents;
  // Compute both deltas with `Math.max(0, …)` so each branch surfaces a
  // non-negative magnitude:
  //   • `leftCents`     — used by the at-or-under-budget branch
  //   • `overByCents`   — used by the over-budget branch (  //                       the original code clamped a single
  //                       `remainingCents` to 0 and then rendered it
  //                       with the `over` suffix, so a 25¢ overspend
  //                       was reported as "$0.00 over". Reporting the
  //                       actual overage matches what the user wants
  //                       to see when the goal is budget_limited.)
  const leftCents = hasBudget ? Math.max(0, budgetCents - costCents) : 0;
  const overByCents = hasBudget ? Math.max(0, costCents - budgetCents) : 0;
  // Clamp to [0, 100] so a slight over-spend (cost > budget) still
  // renders as a fully-filled bar instead of overflowing visually.
  const percent =
    hasBudget && budgetCents > 0 ? Math.min(100, Math.round((costCents / budgetCents) * 100)) : 0;

  return (
    // `col-span-2` keeps Budget full-width at narrow widths so the cost
    // and "X left" stay on one line. At wider widths (`@md:col-span-1`)
    // it shares the row with Turn cap and Auto-compact, and the
    // dd line below switches to a vertical stack to fit ~150px content.
    <div className="bg-surface-secondary col-span-2 rounded-md p-3 @md:col-span-1">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-muted text-xs">Budget</dt>
        {canEdit && (
          <button
            type="button"
            className="text-muted hover:text-foreground text-xs underline"
            aria-label="Edit goal budget"
            onClick={onEdit}
          >
            Edit
          </button>
        )}
      </div>
      <dd className="counter-nums text-foreground mt-1 flex items-baseline justify-between gap-3 leading-tight @md:flex-col @md:items-start @md:gap-0.5">
        <span className="text-base font-medium">
          <span>{formatGoalCents(costCents)}</span>
          {hasBudget && (
            <>
              <span className="text-muted text-sm font-normal"> of </span>
              <span className="text-muted text-sm font-normal">{formatGoalCents(budgetCents)}</span>
            </>
          )}
        </span>
        <span className="text-muted text-xs">
          {hasBudget ? (
            <>
              <span>{formatGoalCents(overBudget ? overByCents : leftCents)}</span>
              {overBudget ? " over" : " left"}
            </>
          ) : (
            "no budget"
          )}
        </span>
      </dd>
      {hasBudget && budgetCents > 0 && (
        <div
          role="progressbar"
          aria-label="Budget used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${formatGoalCents(costCents)} of ${formatGoalCents(budgetCents)} used (${percent}%)`}
          className="bg-border-light mt-2 h-1 overflow-hidden rounded-full"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width]",
              // `atOrOverBudget` (not strict `>`) so reaching the cap
              // exactly still flags visually — the user wants to see
              // "you've hit it" the moment they reach $X of $X.
              atOrOverBudget ? "bg-danger-soft" : "bg-accent"
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface TurnsTileProps {
  turnsUsed: number;
  turnCap: number | null;
  canEdit: boolean;
  onEdit: (event: React.MouseEvent<HTMLButtonElement>) => void;
}

/**
 * Turns / Turn cap as a single tile. Unlike before, the cap is ALWAYS
 * visible alongside usage — when `turnCap == null` we surface a "no cap"
 * label so the user can distinguish "limit not set" from "limit set
 * higher than current usage". The "X / Y" composite text is kept on a
 * single `<span>` so the existing `getByText("3 / 10")` assertion still
 * matches.
 */
function TurnsTile(props: TurnsTileProps) {
  const { turnsUsed, turnCap, canEdit, onEdit } = props;
  const hasCap = turnCap != null;
  // Reserve "over" for strict inequality. Exact saturation renders
  // "0 left"; only real overage uses the over branch.
  const overCap = hasCap && turnsUsed > turnCap;
  const turnsLeft = hasCap ? Math.max(0, turnCap - turnsUsed) : 0;
  const turnsOverBy = hasCap ? Math.max(0, turnsUsed - turnCap) : 0;

  return (
    <div className="bg-surface-secondary rounded-md p-3">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-muted text-xs">Turns</dt>
        {canEdit && (
          <button
            type="button"
            className="text-muted hover:text-foreground text-xs underline"
            aria-label="Edit goal turn cap"
            onClick={onEdit}
          >
            Edit
          </button>
        )}
      </div>
      <dd className="counter-nums text-foreground mt-1 leading-tight">
        <div className="text-base font-medium">
          <span>{hasCap ? `${turnsUsed} / ${turnCap}` : String(turnsUsed)}</span>
        </div>
        <div className="text-muted text-xs">
          {hasCap ? (
            <>
              <span>{overCap ? turnsOverBy : turnsLeft}</span>
              {overCap ? " over" : " left"}
            </>
          ) : (
            "no cap"
          )}
        </div>
      </dd>
    </div>
  );
}

interface GoalAutoCompactSliderProps {
  /**
   * Tri-state per-goal override:
   *   - `null` → no override; the workspace per-model slider governs
   *     and the tile renders in "Default" mode (no slider visible, a
   *     `Customize` button reveals it).
   *   - `100`  → per-goal disabled. Slider sits at the right end with
   *     "Off" labeling.
   *   - `0`–`99` (snapped to 5%) → explicit percent threshold.
   */
  value: number | null;
  /** When false, the tile is read-only (no Customize / no slider drag). */
  canEdit: boolean;
  /**
   * Commit a new override. `null` clears (back to Default mode); a
   * number creates / patches the override. Called on slider release —
   * NOT on every intermediate drag step — so the backend mutation rate
   * stays bounded by user gestures, not pointer-move events.
   */
  onChange: (pct: number | null) => Promise<void> | void;
}

/**
 * Auto-compact threshold (per-goal) tile with an embedded slider.
 *
 * Two visual modes:
 *
 *   1. Default (`value == null`)  — workspace per-model slider applies.
 *      Renders a compact header + `Customize` button. We deliberately
 *      hide the range input here because the slider has no concrete
 *      value to anchor against (we don't know the workspace per-model
 *      threshold at this layer), and a "ghost" thumb at an arbitrary
 *      position would suggest a value that isn't really in effect.
 *
 *   2. Override (`value` is a number) — slider visible with thumb at
 *      `value`. Releasing the thumb commits via `onChange`. A
 *      `Use default` button clears the override back to null.
 *
 * `Customize` seeds an override at `DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT`
 * (70%) so the slider has something concrete to drag from. The user
 * can clear back to "Default" with one click on `Use default`, so the
 * cost of an accidental Customize is one click.
 *
 * Snap behavior matches the workspace `ThresholdSlider`:
 *   - 5% increments
 *   - drag to the rightmost end (≥ 100) → `100` (Off / disabled)
 *   - drag past the enabled max (90) → clamped to 90 unless ≥ 100
 *
 * Tile sizing: spans both columns at narrow widths so the slider has
 * room to breathe; compresses to a 1/3-width tile at wider widths next
 * to the Turn cap tile (see the grid container's `@md:grid-cols-3`).
 */
function GoalAutoCompactSlider(props: GoalAutoCompactSliderProps) {
  const { value, canEdit, onChange } = props;

  if (value == null) {
    return (
      <div className="bg-surface-secondary col-span-2 flex flex-col gap-1 rounded-md p-3 @md:col-span-1">
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-muted text-xs">Auto-compact</dt>
          {canEdit && (
            <button
              type="button"
              className="text-muted hover:text-foreground text-xs underline"
              aria-label="Customize goal auto-compact threshold"
              // Seed the override at the global default so the slider
              // has a concrete value to render. The user immediately
              // sees "70%" and can drag from there.
              onClick={() => void onChange(DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT)}
            >
              Customize
            </button>
          )}
        </div>
        {/* Match the `dl` shape of the other tiles so screen readers
            announce the tile as a term/definition pair. Helper line
            spells out the tri-state without dumping the workspace's
            actual percent (we don't have it here). */}
        <dd className="counter-nums text-foreground mt-1 leading-tight">
          <div className="text-base font-medium">Default</div>
          <div className="text-muted text-xs">workspace setting</div>
        </dd>
      </div>
    );
  }

  return <GoalAutoCompactSliderOverride value={value} canEdit={canEdit} onChange={onChange} />;
}

interface GoalAutoCompactSliderOverrideProps {
  value: number;
  canEdit: boolean;
  onChange: (pct: number | null) => Promise<void> | void;
}

/**
 * Override mode of the per-goal auto-compact tile. Split into its own
 * component so the local "draft" state (used while dragging) lives
 * alongside the slider that needs it — and so this state is created
 * fresh whenever the user re-enters override mode from Default.
 *
 * Why a draft instead of committing every `onChange`? `onChange` for a
 * native range input fires continuously during drag (React unifies the
 * native `input` event with `change`). Committing every step would
 * spam `setGoal` with a backend round-trip per drag pixel. We track a
 * local draft, render it in the value label so dragging feels live,
 * and commit on release (`onPointerUp` / `onKeyUp`).
 *
 * Why no `useEffect` to sync the draft with `value`? Per the
 * `react-effects` skill, syncing prop -> state via effect is an
 * anti-pattern. Instead we use the "store previous prop" pattern
 * (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes)
 * so the draft resets only when the *external* value actually changes
 * (e.g., after a remote goal reload), not while the user is dragging.
 */
function GoalAutoCompactSliderOverride(props: GoalAutoCompactSliderOverrideProps) {
  const { value, canEdit, onChange } = props;
  const [draft, setDraft] = useState(value);
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    setDraft(value);
  }

  const isOff = draft === PER_GOAL_COMPACT_DISABLED_PCT;
  const primary = isOff ? "Off" : `${draft}%`;
  const helper = isOff ? "compaction disabled" : "of context window";

  // Per-gesture commit flag. Touch-capable browsers fire `touchend`
  // and then synthesize a `mousedown`/`mouseup` pair within a short
  // window (often ~50–100ms). With handlers on both events the
  // backend `onChange(draft)` was being called twice for one finger
  // release — the parent's async mutation hasn't resolved by the
  // second event, so `draft !== value` still passes. The Codex P2
  // review flagged this as a duplicate-write bug. Use a ref-tracked
  // flag (not state — we don't want a re-render between commit() and
  // the synthetic mouseup that's about to fire on the same tick) and
  // reset it whenever the user starts a fresh gesture (input event).
  // We deliberately don't use `setTimeout` here per AGENTS.md's
  // "avoid timing-based coordination" rule — the input-event reset
  // ties the flag lifetime to actual user intent.
  const justCommittedRef = useRef(false);

  const commit = () => {
    // Only fire the backend mutation when the slider actually moved
    // (avoids spurious `goal_replaced` history entries from a thumb
    // tap), and only once per gesture (the touch + synthetic mouse
    // sequence above must not double-commit).
    if (justCommittedRef.current) return;
    if (draft !== value) {
      justCommittedRef.current = true;
      void onChange(draft);
    }
  };

  const updateDraftFromEvent = (e: React.SyntheticEvent<HTMLInputElement>) => {
    // The native `input` event fires when a fresh drag/keyboard
    // gesture starts (and on every subsequent step). Clearing the
    // commit-once flag here means the next release will commit
    // again, exactly as the user expects.
    justCommittedRef.current = false;
    setDraft(snapAutoCompactSliderValue(Number(e.currentTarget.value)));
  };

  return (
    <div className="bg-surface-secondary col-span-2 flex flex-col gap-1 rounded-md p-3 @md:col-span-1">
      <div className="flex items-baseline justify-between gap-2">
        <dt className="text-muted text-xs">Auto-compact</dt>
        {canEdit && (
          <button
            type="button"
            className="text-muted hover:text-foreground text-xs underline"
            aria-label="Use workspace default for goal auto-compact"
            onClick={() => void onChange(null)}
          >
            Use default
          </button>
        )}
      </div>
      <dd className="counter-nums text-foreground mt-1 leading-tight">
        <div className="text-base font-medium">
          <span>{primary}</span>
        </div>
        <div className="text-muted text-xs">{helper}</div>
      </dd>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="range"
          min={AUTO_COMPACTION_THRESHOLD_MIN}
          max={PER_GOAL_COMPACT_DISABLED_PCT}
          step={5}
          value={draft}
          disabled={!canEdit}
          // Route drag updates through BOTH `onInput` and `onChange`
          // because:
          //   1. happy-dom (the `tests/ui` runtime) only fires
          //      `onInput` for range inputs — `onChange` is never
          //      called from `fireEvent.input` / `fireEvent.change`,
          //      so the slider would feel read-only in tests.
          //   2. React still needs an `onChange` on every controlled
          //      input or it warns about a missing handler.
          //   3. The handler is idempotent (setDraft to the same
          //      snapped value), so even when both events fire in real
          //      browsers (input first, change on release) the second
          //      call is a no-op state update.
          onInput={updateDraftFromEvent}
          onChange={updateDraftFromEvent}
          // Use the discrete pointer-end events instead of
          // `onPointerUp` because happy-dom does not synthesize pointer
          // events for `fireEvent.pointerUp`. We mirror the rest of the
          // codebase: `mouseUp` for mouse, `touchEnd` for touch,
          // `keyUp` for keyboard arrows. Modern browsers fire all
          // three from the same gesture so commit() may be called
          // twice on a touch interaction — the `draft !== value` guard
          // inside `commit()` collapses that to a single backend call.
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          aria-label="Goal auto-compact threshold percent"
          aria-valuetext={primary}
          className={cn(
            "thinking-slider flex-1",
            // Highlight the thumb so it's visible against the slider
            // track. Mirrors the workspace per-model slider's accent.
            "[--thumb-bg:var(--color-plan-mode)]"
          )}
        />
        {/* "Off" label at the right end mirrors the workspace slider's
            tooltip; the user can drag here to disable compaction
            specifically for this goal. */}
        <span
          className={cn(
            "text-[10px] leading-none uppercase",
            isOff ? "text-plan-mode font-medium" : "text-muted"
          )}
        >
          Off
        </span>
      </div>
    </div>
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
  // they'd get and edit only when they need to. `reload` is wired
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
  // Auto-compact override uses local state (not a ref) because the
  // slider component is controlled — its value drives the slider's
  // thumb position. `null` means "no override" and the create intent
  // omits the field on submit; a number is sent verbatim. Matches the
  // tri-state vocabulary every other goal entry-point (slash command,
  // inline tile editor) uses.
  const [compactThresholdPct, setCompactThresholdPct] = useState<number | null>(null);

  // Effective defaults shown as placeholder text. We seed the inputs with
  // `defaultValue` rather than `value` so the user can clear them; the
  // placeholder mirrors what would be applied if the field is left blank.
  //
  // when `alwaysRequireExplicitBudget` is OFF, a blank budget
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

      // Auto-compact threshold: omit when the slider is in "Default"
      // mode (null) so the goal inherits the workspace per-model
      // setting. When the user has customized via the slider, send the
      // explicit percent verbatim — including `100` (per-goal off) and
      // `0` (the aggressive extreme; honored end-to-end per the Codex
      // P2 fix in `resolveEffectiveThreshold`).
      if (compactThresholdPct !== null) {
        intent.autoCompactionThresholdPct = compactThresholdPct;
      }

      await props.onCreate(intent);
      // Clear the form on success so a returning user sees a blank slate
      // (if for some reason the goal didn't take, e.g., the workspace
      // emitted `goal_conflict` after retry). The parent's `goal`
      // becoming non-null is what actually unmounts the form.
      if (objectiveRef.current) objectiveRef.current.value = "";
      if (budgetRef.current) budgetRef.current.value = "";
      if (turnCapRef.current) turnCapRef.current.value = "";
      setCompactThresholdPct(null);
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
          // `min-h-28` (7rem) keeps the multi-sentence educational
          // placeholder (`GOAL_OBJECTIVE_PLACEHOLDER`) fully visible at
          // typical sidebar widths. Textareas don't scroll placeholder
          // text, so dropping below ~5 lines starts truncating the
          // example phrases the placeholder is meant to teach.
          className="border-border bg-surface-primary text-foreground focus:border-accent min-h-28 w-full rounded-md border p-2 text-sm outline-none"
          aria-label="Goal objective"
          placeholder={GOAL_OBJECTIVE_PLACEHOLDER}
          defaultValue=""
          onKeyDown={(event) => {
            // Cmd/Ctrl+Enter mirrors the inline objective editor. Plain
            // Enter intentionally inserts a newline because goals can span
            // multiple lines.
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

      {/* Per-goal auto-compact override. Reuses the same slider tile
          the active-goal view shows so the create / edit vocabulary is
          identical: "Default" mode = no override (the create intent
          omits the field entirely); Override mode = explicit percent
          that flows verbatim into `setGoal`. The col-span classes on
          the tile are inert in a flex column, so the tile renders at
          its natural full width here. */}
      <GoalAutoCompactSlider
        value={compactThresholdPct}
        canEdit={true}
        onChange={(pct) => setCompactThresholdPct(pct)}
      />

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
