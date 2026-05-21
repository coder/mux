import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ComponentType } from "react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { CHROMATIC_SMOKE_MODES } from "@/browser/stories/meta";
import type { GoalBoardEntry, GoalBoardSnapshot, GoalRecordV1 } from "@/common/types/goal";

import { GoalBoardSections } from "./GoalBoardSections";

/**
 * Visual coverage for the per-row action buttons (Edit / Promote / Remove
 * on Upcoming, Archive on Completed, Revive on Archived). These row
 * controls live in `GoalBoardSections` rather than `GoalTab` itself, and
 * `GoalTab.test.tsx` mocks `GoalBoardSections` away — without these
 * stories the buttons have no automated visual or Chromatic regression
 * coverage. Each story pins the section state that surfaces a different
 * button variant so a future restyle has a chance of being caught.
 */
const meta: Meta<typeof GoalBoardSections> = {
  title: "Features/RightSidebar/GoalBoardSections",
  component: GoalBoardSections,
  parameters: { layout: "padded" },
  // A bare mock APIProvider satisfies the `useAPI()` calls inside each
  // section without spinning up the real websocket-backed provider. The
  // mock client's stubbed `archiveGoal` / `reviveArchivedGoal` / etc.
  // resolve to no-ops so onMutated re-renders are harmless in Storybook.
  decorators: [
    (Story: ComponentType) => (
      <APIProvider client={createMockORPCClient()}>
        <TooltipProvider>
          <div className="bg-surface-primary max-w-md p-3">
            <Story />
          </div>
        </TooltipProvider>
      </APIProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.UTC(2026, 4, 20, 12, 0, 0);

function makeGoal(overrides: Partial<GoalRecordV1> & Pick<GoalRecordV1, "goalId">): GoalRecordV1 {
  return {
    version: 1,
    goalId: overrides.goalId,
    objective: overrides.objective ?? "Untitled goal",
    status: overrides.status ?? "paused",
    budgetCents: overrides.budgetCents ?? null,
    turnCap: overrides.turnCap ?? null,
    costCents: overrides.costCents ?? 0,
    turnsUsed: overrides.turnsUsed ?? 0,
    attributedChildren: overrides.attributedChildren ?? [],
    budgetLimitInjectedForGoalId: overrides.budgetLimitInjectedForGoalId ?? null,
    requireUserAcknowledgmentSinceMs: overrides.requireUserAcknowledgmentSinceMs ?? null,
    createdAtMs: overrides.createdAtMs ?? NOW,
    updatedAtMs: overrides.updatedAtMs ?? NOW,
    ...(overrides.completionSummary != null
      ? { completionSummary: overrides.completionSummary }
      : {}),
  };
}

function entry(
  section: GoalBoardEntry["section"],
  goal: GoalRecordV1,
  endedAtMs?: number
): GoalBoardEntry {
  return endedAtMs != null ? { section, goal, endedAtMs } : { section, goal };
}

const UPCOMING_GOALS: GoalBoardEntry[] = [
  entry(
    "upcoming",
    makeGoal({
      goalId: "11111111-1111-4111-8111-111111111111",
      objective: "Wire goal-board reorder to the keyboard",
      budgetCents: 500,
    })
  ),
  entry(
    "upcoming",
    makeGoal({
      goalId: "22222222-2222-4222-8222-222222222222",
      objective: "Audit goal continuation telemetry",
      budgetCents: null,
    })
  ),
];

const COMPLETED_GOALS: GoalBoardEntry[] = [
  entry(
    "complete",
    makeGoal({
      goalId: "33333333-3333-4333-8333-333333333333",
      objective: "Ship the goal primitive vertical slice",
      status: "complete",
      budgetCents: 500,
      costCents: 412,
      turnsUsed: 8,
      completionSummary: "Lifecycle controls shipped with persistence and tests.",
    }),
    NOW - 60_000
  ),
];

const ARCHIVED_GOALS: GoalBoardEntry[] = [
  entry(
    "archived",
    makeGoal({
      goalId: "44444444-4444-4444-8444-444444444444",
      objective: "Sketch goal-board mobile layout",
      status: "paused",
    }),
    NOW - 3_600_000
  ),
];

const FULL_BOARD: GoalBoardSnapshot = {
  entries: [...UPCOMING_GOALS, ...COMPLETED_GOALS, ...ARCHIVED_GOALS],
};

/**
 * All three sections populated so every row-action button variant
 * (Edit / Promote / Remove / Archive / Revive) renders side-by-side.
 * Catches regressions to the shared `RowActionButton` styling. This is
 * the smoke story for the file — opt into dual-theme Chromatic snapshots
 * so a light-mode regression shows up alongside dark-mode.
 */
export const FullBoard: Story = {
  args: {
    workspaceId: "ws-storybook",
    board: FULL_BOARD,
    onMutated: () => undefined,
  },
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
};

/**
 * Upcoming-only view: surfaces the Edit / Promote / Remove row controls
 * and the dashed "Queue another goal" adder.
 */
export const UpcomingOnly: Story = {
  args: {
    workspaceId: "ws-storybook",
    board: { entries: UPCOMING_GOALS },
    onMutated: () => undefined,
  },
};

/**
 * Completed-only view. This is the section the Archive button lives in,
 * the affordance that motivated the row-action restyle.
 */
export const CompletedOnly: Story = {
  args: {
    workspaceId: "ws-storybook",
    board: { entries: COMPLETED_GOALS },
    onMutated: () => undefined,
  },
};

/**
 * Archived-only view. Surfaces the Revive button (mirror of Archive).
 */
export const ArchivedOnly: Story = {
  args: {
    workspaceId: "ws-storybook",
    board: { entries: ARCHIVED_GOALS },
    onMutated: () => undefined,
  },
};

/**
 * Empty board → the renderer collapses to a lone `UpcomingAdder` (the
 * dashed "Queue another goal" button). Pins the empty-state visual so
 * future redesigns don't accidentally render section chrome with zero
 * entries.
 */
export const EmptyBoard: Story = {
  args: {
    workspaceId: "ws-storybook",
    board: { entries: [] },
    onMutated: () => undefined,
  },
};
