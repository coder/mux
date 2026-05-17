import type { Meta, StoryObj } from "@storybook/react-vite";
import { GoalTab } from "./GoalTab";

const meta: Meta<typeof GoalTab> = {
  title: "Features/RightSidebar/GoalTab",
  component: GoalTab,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyWithCreateForm: Story = {
  // Empty-state surface that wires the in-tab create form. Mirrors the
  // slash-command `goal-set` shape (objective + optional budget + turn
  // cap). The `onCreate` mock keeps the form interactive in Storybook
  // without hitting a backend.
  args: {
    goal: null,
    onCreate: () => undefined,
  },
};

export const EmptyReadOnly: Story = {
  // Read-only fallback when no create callback is wired (e.g., storybook
  // stories that exercise the legacy placeholder). Asserts the empty-state
  // gracefully degrades instead of crashing.
  args: {
    goal: null,
  },
};

export const Active: Story = {
  args: {
    goal: {
      goalId: "11111111-1111-4111-8111-111111111111",
      status: "active",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 0,
      turnsUsed: 0,
      turnCap: null,
      startedAtMs: Date.now(),
    },
  },
};

export const ActiveWithAccounting: Story = {
  args: {
    goal: {
      goalId: "44444444-4444-4444-8444-444444444444",
      status: "active",
      objective: "Ship the cost accumulator vertical slice",
      budgetCents: 500,
      costCents: 125,
      turnsUsed: 3,
      turnCap: 10,
      startedAtMs: Date.now() - 90_000,
    },
  },
};

export const Paused: Story = {
  args: {
    goal: {
      goalId: "22222222-2222-4222-8222-222222222222",
      status: "paused",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 125,
      turnsUsed: 3,
      turnCap: null,
      startedAtMs: Date.now(),
    },
  },
};

export const BudgetLimited: Story = {
  args: {
    goal: {
      goalId: "55555555-5555-4555-8555-555555555555",
      status: "budget_limited",
      objective: "Ship the budget-limited transition slice",
      budgetCents: 500,
      costCents: 525,
      turnsUsed: 4,
      turnCap: 10,
      startedAtMs: Date.now() - 120_000,
    },
  },
};

export const Complete: Story = {
  args: {
    goal: {
      goalId: "33333333-3333-4333-8333-333333333333",
      status: "complete",
      objective: "Ship the goal primitive vertical slice",
      budgetCents: null,
      costCents: 250,
      turnsUsed: 5,
      turnCap: null,
      completionSummary: "The lifecycle controls shipped with persistence and tests.",
      startedAtMs: Date.now(),
    },
  },
};

export const ActiveWithHistory: Story = {
  args: {
    goal: {
      goalId: "66666666-6666-4666-8666-666666666666",
      status: "active",
      objective: "Ship the goal-history UX iteration",
      budgetCents: 1000,
      costCents: 150,
      turnsUsed: 2,
      turnCap: null,
      startedAtMs: Date.now() - 30_000,
    },
    history: [
      {
        version: 1,
        endReason: "completed",
        endedAtMs: Date.now() - 60_000,
        goal: {
          version: 1,
          goalId: "77777777-7777-4777-8777-777777777777",
          objective: "Wire up budget + turn-cap accounting",
          status: "complete",
          budgetCents: 500,
          costCents: 480,
          costMicroCents: 480_000_000,
          turnsUsed: 8,
          turnCap: 10,
          attributedChildren: [],
          budgetLimitInjectedForGoalId: null,
          requireUserAcknowledgmentSinceMs: null,
          lastContinuationFiredAtMs: null,
          completionSummary: "All accounting tests pass and budgets propagate end-to-end.",
          createdAtMs: Date.now() - 5 * 60_000,
          updatedAtMs: Date.now() - 60_000,
        },
      },
      {
        version: 1,
        endReason: "cleared",
        endedAtMs: Date.now() - 5 * 60_000,
        goal: {
          version: 1,
          goalId: "88888888-8888-4888-8888-888888888888",
          objective: "Spike on lifecycle events without committing",
          status: "paused",
          budgetCents: null,
          costCents: 25,
          costMicroCents: 25_000_000,
          turnsUsed: 1,
          turnCap: null,
          attributedChildren: [],
          budgetLimitInjectedForGoalId: null,
          requireUserAcknowledgmentSinceMs: null,
          lastContinuationFiredAtMs: null,
          createdAtMs: Date.now() - 10 * 60_000,
          updatedAtMs: Date.now() - 5 * 60_000,
        },
      },
    ],
  },
};
