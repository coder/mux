import {
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Inbox,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { useRef, useState } from "react";

import { useAPI } from "@/browser/contexts/API";
import { useGoalDefaults } from "@/browser/utils/goals/useGoalDefaults";
import { cn } from "@/common/lib/utils";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalRecordV1 } from "@/common/types/goal";
import { formatGoalCents } from "@/common/utils/goals/budgetPricing";
import { parseGoalBudgetInputCents } from "@/common/utils/goals/budgetParser";

/**
 * Renderer for the three non-active board sections (upcoming, completed,
 * archived). The active goal is already rendered above by `GoalTab` —
 * this component slots in beneath it.
 *
 * Sections are independently collapsible. Upcoming defaults to open
 * (it's the user's roadmap), completed + archived default to closed
 * (out of the way until explicitly opened). Each row has compact ops:
 *
 *   upcoming → up/down/Promote/Archive
 *   completed → Archive
 *   archived → Revive (back to upcoming)
 *
 * DnD (free drag-to-reorder) is intentionally deferred to a follow-up
 * — up/down buttons cover the same intent with keyboard accessibility
 * and without a new dependency.
 */
interface GoalBoardSectionsProps {
  workspaceId: string;
  board: GoalBoardSnapshot;
  /** Called after a mutation so the parent re-reads board state. */
  onMutated: () => void;
}

export function GoalBoardSections(props: GoalBoardSectionsProps) {
  const upcoming = props.board.entries.filter((e) => e.section === "upcoming");
  const completed = props.board.entries.filter((e) => e.section === "complete");
  const archived = props.board.entries.filter((e) => e.section === "archived");

  // Nothing to show? Don't render the chrome at all — keeps the tab
  // visually quiet when the workspace is using only the active goal.
  if (upcoming.length === 0 && completed.length === 0 && archived.length === 0) {
    return <UpcomingAdder workspaceId={props.workspaceId} onAdded={props.onMutated} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <UpcomingSection
        workspaceId={props.workspaceId}
        entries={upcoming}
        onMutated={props.onMutated}
      />
      <CompletedSection
        workspaceId={props.workspaceId}
        entries={completed}
        onMutated={props.onMutated}
      />
      <ArchivedSection
        workspaceId={props.workspaceId}
        entries={archived}
        onMutated={props.onMutated}
      />
    </div>
  );
}

interface SectionShellProps {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}

function SectionShell(props: SectionShellProps) {
  const [isOpen, setIsOpen] = useState(props.defaultOpen);
  return (
    <section className="border-border-light bg-surface-secondary rounded-md border">
      <button
        type="button"
        className="hover:bg-surface-tertiary flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs tracking-wide uppercase"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        {isOpen ? (
          <ChevronDown className="text-muted h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="text-muted h-3 w-3" aria-hidden="true" />
        )}
        <span className="text-foreground font-medium">{props.title}</span>
        <span className="text-muted lowercase">({props.count})</span>
        {props.trailing && <span className="ml-auto">{props.trailing}</span>}
      </button>
      {isOpen && <div className="border-border-light border-t p-2">{props.children}</div>}
    </section>
  );
}

interface UpcomingSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function UpcomingSection(props: UpcomingSectionProps) {
  const { api } = useAPI();

  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= props.entries.length) return;
    if (!api) return;
    const ids = props.entries.map((e) => e.goal.goalId);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await api.workspace.reorderUpcomingGoals({
      workspaceId: props.workspaceId,
      upcomingIds: ids,
    });
    props.onMutated();
  };

  const promote = async (goalId: string) => {
    if (!api) return;
    await api.workspace.promoteUpcomingGoal({ workspaceId: props.workspaceId, goalId });
    props.onMutated();
  };

  const archive = async (goalId: string) => {
    if (!api) return;
    await api.workspace.archiveGoal({ workspaceId: props.workspaceId, goalId });
    props.onMutated();
  };

  return (
    <SectionShell title="Upcoming" count={props.entries.length} defaultOpen>
      <div className="flex flex-col gap-1.5">
        {props.entries.map((entry, idx) => (
          <UpcomingRow
            key={entry.goal.goalId}
            goal={entry.goal}
            isFirst={idx === 0}
            isLast={idx === props.entries.length - 1}
            onMoveUp={() => move(idx, -1)}
            onMoveDown={() => move(idx, +1)}
            onPromote={() => promote(entry.goal.goalId)}
            onArchive={() => archive(entry.goal.goalId)}
          />
        ))}
        <UpcomingAdder workspaceId={props.workspaceId} onAdded={props.onMutated} />
      </div>
    </SectionShell>
  );
}

interface UpcomingRowProps {
  goal: GoalRecordV1;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => Promise<void> | void;
  onMoveDown: () => Promise<void> | void;
  onPromote: () => Promise<void> | void;
  onArchive: () => Promise<void> | void;
}

function UpcomingRow(props: UpcomingRowProps) {
  return (
    <div className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm">
      <div className="flex flex-col">
        {/* Reorder buttons — keyboard-accessible substitute for DnD. */}
        <button
          type="button"
          className="text-muted hover:text-foreground disabled:opacity-30"
          disabled={props.isFirst}
          aria-label="Move goal up"
          onClick={() => void props.onMoveUp()}
        >
          <ArrowUp className="h-3 w-3" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="text-muted hover:text-foreground disabled:opacity-30"
          disabled={props.isLast}
          aria-label="Move goal down"
          onClick={() => void props.onMoveDown()}
        >
          <ArrowDown className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
      <span className="text-foreground line-clamp-1 flex-1 font-medium">
        {props.goal.objective}
      </span>
      <span className="text-muted counter-nums shrink-0 text-xs">
        {props.goal.budgetCents == null ? "no budget" : formatGoalCents(props.goal.budgetCents)}
      </span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="text-muted hover:text-success inline-flex items-center gap-0.5 text-xs"
          aria-label={`Promote ${props.goal.objective}`}
          onClick={() => void props.onPromote()}
        >
          <Play className="h-3 w-3" aria-hidden="true" />
          Promote
        </button>
        <button
          type="button"
          className="text-muted hover:text-danger-soft inline-flex items-center gap-0.5 text-xs"
          aria-label={`Archive ${props.goal.objective}`}
          onClick={() => void props.onArchive()}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

interface CompletedSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function CompletedSection(props: CompletedSectionProps) {
  const { api } = useAPI();

  if (props.entries.length === 0) return null;

  const archive = async (goalId: string) => {
    if (!api) return;
    await api.workspace.archiveGoal({ workspaceId: props.workspaceId, goalId });
    props.onMutated();
  };

  return (
    <SectionShell title="Completed" count={props.entries.length} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {props.entries.map((entry) => (
          <div
            key={entry.goal.goalId}
            className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="text-foreground line-clamp-1 flex-1">{entry.goal.objective}</span>
            <span className="text-muted counter-nums shrink-0 text-xs">
              {formatGoalCents(entry.goal.costCents)}
            </span>
            <button
              type="button"
              className="text-muted hover:text-foreground inline-flex items-center gap-0.5 text-xs"
              aria-label={`Archive ${entry.goal.objective}`}
              onClick={() => void archive(entry.goal.goalId)}
            >
              <Inbox className="h-3 w-3" aria-hidden="true" />
              Archive
            </button>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

interface ArchivedSectionProps {
  workspaceId: string;
  entries: GoalBoardEntry[];
  onMutated: () => void;
}

function ArchivedSection(props: ArchivedSectionProps) {
  const { api } = useAPI();
  if (props.entries.length === 0) return null;

  const revive = async (goalId: string) => {
    if (!api) return;
    await api.workspace.reviveArchivedGoal({ workspaceId: props.workspaceId, goalId });
    props.onMutated();
  };

  return (
    <SectionShell title="Archived" count={props.entries.length} defaultOpen={false}>
      <div className="flex flex-col gap-1.5">
        {props.entries.map((entry) => (
          <div
            key={entry.goal.goalId}
            className="border-border-light bg-surface-primary flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
          >
            <span className="text-foreground line-clamp-1 flex-1">{entry.goal.objective}</span>
            <button
              type="button"
              className="text-muted hover:text-foreground inline-flex items-center gap-0.5 text-xs"
              aria-label={`Revive ${entry.goal.objective}`}
              onClick={() => void revive(entry.goal.goalId)}
            >
              <ArchiveRestore className="h-3 w-3" aria-hidden="true" />
              Revive
            </button>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

interface UpcomingAdderProps {
  workspaceId: string;
  onAdded: () => void;
}

function UpcomingAdder(props: UpcomingAdderProps) {
  const { api } = useAPI();
  const { defaults } = useGoalDefaults(props.workspaceId);
  const [isOpen, setIsOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const objectiveRef = useRef<HTMLInputElement | null>(null);
  const budgetRef = useRef<HTMLInputElement | null>(null);

  const reset = () => {
    if (objectiveRef.current) objectiveRef.current.value = "";
    if (budgetRef.current) budgetRef.current.value = "";
    setError(null);
  };

  const submit = async () => {
    if (!api) return;
    const objective = (objectiveRef.current?.value ?? "").trim();
    if (objective.length === 0) {
      setError("Goal objective is required.");
      objectiveRef.current?.focus();
      return;
    }
    let budgetCents: number | null | undefined;
    const rawBudget = (budgetRef.current?.value ?? "").trim();
    if (rawBudget.length > 0) {
      const parsed = parseGoalBudgetInputCents(rawBudget);
      if (parsed === undefined) {
        setError("Enter a budget like $5 or 500c. Use 0 or blank for no budget.");
        return;
      }
      budgetCents = parsed;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await api.workspace.addUpcomingGoal({
        workspaceId: props.workspaceId,
        objective,
        ...(budgetCents !== undefined ? { budgetCents } : {}),
      });
      reset();
      setIsOpen(false);
      props.onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to queue goal.");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        className={cn(
          "text-muted hover:text-foreground border-border-light inline-flex items-center gap-1",
          "rounded-md border border-dashed px-2 py-1.5 text-xs"
        )}
        aria-label="Queue another goal"
        onClick={() => setIsOpen(true)}
      >
        <Plus className="h-3 w-3" aria-hidden="true" />
        Queue another goal
      </button>
    );
  }

  return (
    <div className="border-border-light bg-surface-primary flex flex-col gap-2 rounded-md border p-2">
      <input
        ref={objectiveRef}
        aria-label="Queued goal objective"
        placeholder="Describe the next goal"
        className="border-border bg-surface-primary text-foreground focus:border-accent rounded-md border p-1.5 text-sm outline-none"
        autoFocus
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setIsOpen(false);
            reset();
          }
        }}
      />
      <div className="flex items-center gap-2">
        <input
          ref={budgetRef}
          aria-label="Queued goal budget"
          placeholder={`$${(defaults.defaultBudgetCents / 100).toFixed(2)} (default)`}
          className="border-border bg-surface-primary text-foreground focus:border-accent w-32 rounded-md border p-1.5 text-xs outline-none"
        />
        <button
          type="button"
          className="bg-accent text-accent-foreground rounded-md px-2 py-1 text-xs disabled:opacity-60"
          disabled={isSubmitting}
          onClick={() => void submit()}
        >
          {isSubmitting ? "Queuing…" : "Queue goal"}
        </button>
        <button
          type="button"
          className="border-border-light text-muted hover:text-foreground rounded-md border px-2 py-1 text-xs"
          onClick={() => {
            setIsOpen(false);
            reset();
          }}
        >
          Cancel
        </button>
      </div>
      {error && (
        <p className="text-danger-soft text-xs" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
