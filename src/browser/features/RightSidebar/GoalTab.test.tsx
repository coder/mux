import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";
import type { GoalSnapshot } from "@/common/types/goal";
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
});
