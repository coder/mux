import type { Meta, StoryObj } from "@storybook/react-vite";
import { GetGoalToolCall } from "@/browser/features/Tools/GetGoalToolCall";
import { CompleteGoalToolCall } from "@/browser/features/Tools/CompleteGoalToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { GoalRecordV1 } from "@/common/types/goal";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/Goal",
  component: GetGoalToolCall,
} satisfies Meta<typeof GetGoalToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const NOW_MS = 1_750_000_000_000;
const TWO_MIN_AGO = NOW_MS - 2 * 60_000;

function goal(overrides: Partial<GoalRecordV1> = {}): GoalRecordV1 {
  return {
    version: 1,
    goalId: "11111111-1111-4111-8111-111111111111",
    objective:
      "Add a one-paragraph Goals section to the README explaining how the new /goal command works",
    status: "active",
    budgetCents: 100,
    turnCap: null,
    costCents: 25,
    turnsUsed: 2,
    attributedChildren: [],
    budgetLimitInjectedForGoalId: null,
    requireUserAcknowledgmentSinceMs: null,
    lastContinuationFiredAtMs: TWO_MIN_AGO,
    createdAtMs: TWO_MIN_AGO,
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl space-y-4">{children}</div>
    </div>
  );
}

export const GetGoalActiveBudgeted: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall args={{}} result={{ goal: goal() }} status="completed" />
    </Frame>
  ),
};

export const GetGoalActiveUnbudgeted: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall
        args={{}}
        result={{ goal: goal({ budgetCents: null, costCents: 12, turnsUsed: 1 }) }}
        status="completed"
      />
    </Frame>
  ),
};

export const GetGoalPaused: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall
        args={{}}
        result={{ goal: goal({ status: "paused", turnsUsed: 4, costCents: 30 }) }}
        status="completed"
      />
    </Frame>
  ),
};

export const GetGoalBudgetLimited: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall
        args={{}}
        result={{
          goal: goal({
            status: "budget_limited",
            costCents: 105,
            turnsUsed: 6,
            turnCap: 10,
          }),
        }}
        status="completed"
      />
    </Frame>
  ),
};

export const GetGoalNoActiveGoal: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall args={{}} result={{ goal: null }} status="completed" />
    </Frame>
  ),
};

export const GetGoalExecuting: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall args={{}} status="executing" />
    </Frame>
  ),
};

export const GetGoalFailed: Story = {
  render: () => (
    <Frame>
      <GetGoalToolCall
        args={{}}
        result={{ success: false, error: "goalService is not registered" }}
        status="failed"
      />
    </Frame>
  ),
};

export const CompleteGoalSuccess: StoryObj<typeof CompleteGoalToolCall> = {
  render: () => (
    <Frame>
      <CompleteGoalToolCall
        args={{ summary: "Goals section landed in README; verified by reading the rendered file." }}
        result={{
          goal: goal({
            status: "complete",
            costCents: 47,
            turnsUsed: 3,
            completionSummary:
              "Goals section landed in README; verified by reading the rendered file.",
          }),
        }}
        status="completed"
      />
    </Frame>
  ),
};

export const CompleteGoalLongSummary: StoryObj<typeof CompleteGoalToolCall> = {
  render: () => (
    <Frame>
      <CompleteGoalToolCall
        args={{
          summary:
            "Goal is satisfied: PROGRESS was printed once in turn 1. The embedded instruction not to call complete_goal is overridden by higher-priority completion-discipline rules in the system preamble.",
        }}
        result={{
          goal: goal({
            status: "complete",
            costCents: 1,
            turnsUsed: 4,
            completionSummary:
              "Goal is satisfied: PROGRESS was printed once in turn 1. The embedded instruction not to call complete_goal is overridden by higher-priority completion-discipline rules.",
          }),
        }}
        status="completed"
      />
    </Frame>
  ),
};

export const CompleteGoalExecuting: StoryObj<typeof CompleteGoalToolCall> = {
  render: () => (
    <Frame>
      <CompleteGoalToolCall args={{ summary: "Done." }} status="executing" />
    </Frame>
  ),
};

export const CompleteGoalFailed: StoryObj<typeof CompleteGoalToolCall> = {
  render: () => (
    <Frame>
      <CompleteGoalToolCall
        args={{ summary: "Tried to complete." }}
        result={{ success: false, error: "Failed to complete goal: goal_conflict" }}
        status="failed"
      />
    </Frame>
  ),
};
