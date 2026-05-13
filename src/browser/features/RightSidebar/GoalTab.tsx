import { Target } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { GoalSnapshot, GoalStatus } from "@/common/types/goal";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import { parseGoalBudgetInputCents } from "@/common/utils/goals/budgetParser";
// Import shared formatters / status labels from goalToolUtils so the GoalTab
// stays in sync with the tool-call cards (Coder-agents-review nits DEREM-28
// + DEREM-29). Local copies drifted in case (`active` vs `Active`) and could
// drift further as Goal status grows.
import { formatGoalElapsed, goalStatusLabel } from "@/browser/features/Tools/Goal/goalToolUtils";

interface GoalTabProps {
  goal: GoalSnapshot | null;
  openCompleteInputRequest?: number;
  // GoalTab UI only invokes user-facing transitions (pause/resume/complete);
  // `budget_limited` is internal-only and is excluded from the public oRPC
  // `setGoal` input shape (Coder-agents-review nit DEREM-53).
  onSetStatus?: (
    status: Exclude<GoalStatus, "budget_limited">,
    completionSummary?: string
  ) => Promise<void> | void;
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

export function GoalTab(props: GoalTabProps) {
  const [isSummaryInputOpen, setIsSummaryInputOpen] = useState(false);
  const [editingField, setEditingField] = useState<"budget" | "turnCap" | null>(null);
  const [editValue, setEditValue] = useState("");
  const [summary, setSummary] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const originRef = useRef<HTMLElement | null>(null);
  const lastCompleteInputRequestRef = useRef(props.openCompleteInputRequest ?? 0);

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
      const submittedValue = editInputRef.current?.value ?? editValue;
      if (editingField === "budget") {
        const budgetCents = parseBudgetInput(submittedValue);
        if (budgetCents === undefined) {
          setError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
          return;
        }
        await props.onUpdateBudget?.(budgetCents);
      } else if (editingField === "turnCap") {
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
    if (request > 0 && props.goal && props.goal.status !== "complete") {
      openSummaryInput(
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      );
    }
  }, [props.openCompleteInputRequest, props.goal]);

  if (!props.goal) {
    return (
      <div className="text-muted flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
        <Target className="h-5 w-5" aria-hidden="true" />
        <p>No goal is set for this workspace.</p>
      </div>
    );
  }

  const canPause = props.goal.status === "active";
  const canResume = props.goal.status === "paused";
  const canComplete = props.goal.status === "active" || props.goal.status === "budget_limited";

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
    <section className="flex h-full flex-col gap-4 p-4" aria-label="Workspace goal">
      <header className="border-border-light bg-surface-secondary rounded-md border p-3">
        <div className="text-muted mb-1 flex items-center gap-1.5 text-xs font-medium uppercase">
          <Target className="h-3.5 w-3.5" aria-hidden="true" />
          Goal {goalStatusLabel(props.goal.status)}
        </div>
        <h2 className="text-foreground text-sm leading-5 font-semibold whitespace-pre-wrap">
          {props.goal.objective}
        </h2>
      </header>

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
            <button
              type="button"
              className="text-muted hover:text-foreground text-xs underline"
              aria-label="Edit goal budget"
              onClick={(event) => openBudgetEditor(event.currentTarget)}
            >
              Edit
            </button>
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
            <button
              type="button"
              className="text-muted hover:text-foreground text-xs underline"
              aria-label="Edit goal turn cap"
              onClick={(event) => openTurnCapEditor(event.currentTarget)}
            >
              Edit
            </button>
          </dd>
        </div>
        <div className="bg-surface-secondary rounded-md p-3">
          <dt className="text-muted text-xs">Elapsed</dt>
          <dd className="counter-nums text-foreground">
            {formatGoalElapsed(props.goal.startedAtMs)}
          </dd>
        </div>
      </dl>

      {editingField && (
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
        <button
          type="button"
          className="border-border-light bg-surface-secondary text-foreground hover:bg-surface-tertiary rounded-md border px-3 py-1.5 text-sm"
          aria-label="Clear goal"
          onClick={() => void clearGoal()}
        >
          Clear
        </button>
      </div>

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
    </section>
  );
}
