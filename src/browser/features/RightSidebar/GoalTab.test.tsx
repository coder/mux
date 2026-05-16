import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { GoalHistoryEntry, GoalSnapshot } from "@/common/types/goal";
import { GoalTab } from "./GoalTab";

function goal(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    objective: "Ship the goal lifecycle slice",
    budgetCents: null,
    costCents: 125,
    turnsUsed: 3,
    turnCap: null,
    startedAtMs: Date.now(),
    ...overrides,
  };
}

describe("GoalTab", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders lifecycle buttons based on status", () => {
    const { rerender, getByLabelText, queryByLabelText } = render(
      <GoalTab goal={goal()} onSetStatus={mock()} onClear={mock()} />
    );

    expect(getByLabelText("Pause goal")).toBeTruthy();
    expect(getByLabelText("Mark goal complete")).toBeTruthy();
    expect(queryByLabelText("Resume goal")).toBeNull();

    rerender(<GoalTab goal={goal({ status: "paused" })} onSetStatus={mock()} onClear={mock()} />);
    expect(getByLabelText("Resume goal")).toBeTruthy();
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Mark goal complete")).toBeNull();

    rerender(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "All work is complete." })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Resume goal")).toBeNull();
    expect(queryByLabelText("Mark goal complete")).toBeNull();
    expect(getByLabelText("Completion summary").textContent).toContain("All work is complete.");

    // Coder-agents-review P3 DEREM-39: budget_limited must keep the manual
    // "Mark goal complete" button so the user can wrap up after exhausting
    // the budget. Pause is hidden because the goal is already paused-ish
    // (no auto-continuation), and Resume is hidden because the goal is
    // not in the `paused` state.
    rerender(
      <GoalTab
        goal={goal({ status: "budget_limited", budgetCents: 100, costCents: 100 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    expect(getByLabelText("Mark goal complete")).toBeTruthy();
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Resume goal")).toBeNull();
  });

  test("renders accounting breakdown", () => {
    const startedAtMs = Date.now() - 90_000;
    const { getByText } = render(
      <GoalTab
        goal={goal({
          budgetCents: 500,
          costCents: 125,
          turnsUsed: 3,
          turnCap: 10,
          startedAtMs,
        })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(getByText("$1.25")).toBeTruthy();
    expect(getByText("$5.00")).toBeTruthy();
    expect(getByText("$3.75")).toBeTruthy();
    expect(getByText("3 / 10")).toBeTruthy();
  });

  test("renders pending goals read-only until they are saved", () => {
    const { queryByLabelText } = render(
      <GoalTab
        goal={goal({ pendingPersistence: true, budgetCents: 500, turnCap: 10 })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );

    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(queryByLabelText("Mark goal complete")).toBeNull();
    expect(queryByLabelText("Clear goal")).toBeNull();
    expect(queryByLabelText("Edit goal budget")).toBeNull();
    expect(queryByLabelText("Edit goal turn cap")).toBeNull();
  });

  test("edits budget inline and restores focus", async () => {
    const onUpdateBudget = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ budgetCents: 500 })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateBudget={onUpdateBudget}
      />
    );

    const opener = getByLabelText("Edit goal budget");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal budget amount");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.input(input, { target: { value: "$7.50" } });
    fireEvent.click(getByText("Save budget"));

    await waitFor(() => expect(onUpdateBudget).toHaveBeenCalledWith(750));
    expect(document.activeElement).toBe(opener);
  });

  test("edits turn cap inline", async () => {
    const onUpdateTurnCap = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ turnCap: 10 })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateTurnCap={onUpdateTurnCap}
      />
    );

    fireEvent.click(getByLabelText("Edit goal turn cap"));
    const input = getByLabelText("Goal turn cap");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.input(input, { target: { value: "15" } });
    fireEvent.click(getByText("Save turn cap"));

    await waitFor(() => expect(onUpdateTurnCap).toHaveBeenCalledWith(15));
  });

  test("opens completion summary input, traps focus, submits, and restores focus", async () => {
    const onSetStatus = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText, queryByLabelText } = render(
      <GoalTab goal={goal()} onSetStatus={onSetStatus} onClear={mock()} />
    );

    const opener = getByLabelText("Mark goal complete");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal completion summary");
    await waitFor(() => expect(document.activeElement).toBe(input));

    const cancel = getByText("Cancel");
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(input);

    (input as HTMLTextAreaElement).value = "Finished with tests passing.";
    fireEvent.input(input);
    fireEvent.click(getByText("Save summary"));

    await waitFor(() => {
      expect(onSetStatus).toHaveBeenCalledWith("complete", "Finished with tests passing.");
    });
    expect(queryByLabelText("Goal completion summary")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("edits goal objective in place and skips no-op edits", async () => {
    const onUpdateObjective = mock(() => Promise.resolve(undefined));
    const { getByLabelText, getByText } = render(
      <GoalTab
        goal={goal({ objective: "Initial objective" })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateObjective={onUpdateObjective}
      />
    );

    const opener = getByLabelText("Edit goal objective");
    opener.focus();
    fireEvent.click(opener);

    const input = getByLabelText("Goal objective") as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(input));

    // No-op edit: same value should close the editor without calling the
    // update handler (avoids spurious lifecycle events / IPC churn).
    fireEvent.click(getByText("Save objective"));
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(onUpdateObjective).not.toHaveBeenCalled();

    // Real edit propagates the trimmed objective.
    fireEvent.click(opener);
    const reopenedInput = getByLabelText("Goal objective") as HTMLTextAreaElement;
    fireEvent.input(reopenedInput, { target: { value: "  Refined objective  " } });
    fireEvent.click(getByText("Save objective"));

    await waitFor(() => expect(onUpdateObjective).toHaveBeenCalledWith("Refined objective"));
  });

  test("hides the objective editor for completed goals", () => {
    const { queryByLabelText } = render(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "Wrapped up." })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateObjective={mock()}
      />
    );

    // Once a goal is complete the right-sidebar action set collapses to
    // "Archive this goal" — renaming a frozen objective makes no UX sense.
    expect(queryByLabelText("Edit goal objective")).toBeNull();
  });

  test("clear control is de-prominent and relabels for completed goals", () => {
    const { getByLabelText, getByText, rerender, queryByText } = render(
      <GoalTab goal={goal()} onSetStatus={mock()} onClear={mock()} />
    );

    // Active goal: the clear control exists but is rendered as a small text
    // link — no primary-button background classes are applied.
    const clearButton = getByLabelText("Clear goal");
    expect(clearButton.className).not.toContain("bg-accent");
    expect(clearButton.className).toContain("underline");
    expect(getByText("Clear goal")).toBeTruthy();

    rerender(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "Wrapped up." })}
        onSetStatus={mock()}
        onClear={mock()}
      />
    );
    // Completed goals: the action is "archive" (move into history). The label
    // wording is part of the user-visible UX contract.
    expect(getByLabelText("Clear goal")).toBeTruthy();
    expect(getByText("Archive this goal")).toBeTruthy();
    expect(queryByText("Clear goal")).toBeNull();
  });

  test("renders completed-goals history with expandable detail", () => {
    const entry: GoalHistoryEntry = {
      version: 1,
      endReason: "completed",
      endedAtMs: Date.now(),
      goal: {
        version: 1,
        goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objective: "Old objective",
        status: "complete",
        budgetCents: 500,
        costCents: 250,
        costMicroCents: 250_000_000,
        turnsUsed: 5,
        turnCap: null,
        attributedChildren: [],
        budgetLimitInjectedForGoalId: null,
        requireUserAcknowledgmentSinceMs: null,
        lastContinuationFiredAtMs: null,
        completionSummary: "Old goal wrap-up.",
        createdAtMs: Date.now() - 60_000,
        updatedAtMs: Date.now(),
      },
    };

    const { getByLabelText, getByText, queryByText } = render(
      <GoalTab goal={goal()} onSetStatus={mock()} onClear={mock()} history={[entry]} />
    );

    expect(getByText("Completed goals")).toBeTruthy();
    // Compact row exposes the objective; the completion summary is gated
    // behind the expand toggle (this is the "expand the card to see details"
    // requirement).
    expect(getByText("Old objective")).toBeTruthy();
    expect(queryByText("Old goal wrap-up.")).toBeNull();

    fireEvent.click(getByLabelText("Expand completed goal: Old objective"));
    expect(getByText("Old goal wrap-up.")).toBeTruthy();
    // Old goals are read-only — no resume / pause action is offered. Resume
    // is the canonical "may not be resumed" affordance to guard against.
    expect(queryByText("Resume")).toBeNull();
  });

  test("filters out history entries that still reference the current goal id", () => {
    const current = goal({ goalId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const entry: GoalHistoryEntry = {
      version: 1,
      endReason: "replaced",
      endedAtMs: Date.now(),
      goal: {
        version: 1,
        goalId: current.goalId,
        objective: current.objective,
        status: "active",
        budgetCents: null,
        costCents: 0,
        costMicroCents: 0,
        turnsUsed: 0,
        turnCap: null,
        attributedChildren: [],
        budgetLimitInjectedForGoalId: null,
        requireUserAcknowledgmentSinceMs: null,
        lastContinuationFiredAtMs: null,
        createdAtMs: Date.now() - 1_000,
        updatedAtMs: Date.now(),
      },
    };

    const { queryByText } = render(
      <GoalTab goal={current} onSetStatus={mock()} onClear={mock()} history={[entry]} />
    );

    // The stale-mirror entry must not appear: it would otherwise render the
    // present goal twice during the brief window between an in-place edit and
    // the next history re-fetch.
    expect(queryByText("Completed goals")).toBeNull();
  });

  test("renders history list when no current goal is set", () => {
    const entry: GoalHistoryEntry = {
      version: 1,
      endReason: "cleared",
      endedAtMs: Date.now(),
      goal: {
        version: 1,
        goalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        objective: "Previously-cleared goal",
        status: "paused",
        budgetCents: null,
        costCents: 100,
        costMicroCents: 100_000_000,
        turnsUsed: 2,
        turnCap: null,
        attributedChildren: [],
        budgetLimitInjectedForGoalId: null,
        requireUserAcknowledgmentSinceMs: null,
        lastContinuationFiredAtMs: null,
        createdAtMs: Date.now() - 60_000,
        updatedAtMs: Date.now(),
      },
    };

    const { getByText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} history={[entry]} />
    );

    // The empty-state still surfaces history so the user can review prior
    // work before starting a new goal.
    expect(getByText("No goal is set for this workspace.")).toBeTruthy();
    expect(getByText("Previously-cleared goal")).toBeTruthy();
  });
});
