import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createContext } from "react";
import { installDom } from "../../../../tests/ui/dom";
import type { GoalHistoryEntry, GoalSnapshot } from "@/common/types/goal";

// The GoalTab now reaches into `useAPI` (via `useGoalDefaults`) when the
// create form is mounted. The hook tolerates a null api gracefully, but
// `useAPI` itself throws when used outside a provider. Mock the context
// so renders without an APIProvider still work — the form falls back to
// canonical defaults, which is exactly the storybook-without-provider
// behavior we want at runtime too.
//
// `useGoalDefaults` and `useGoalBoard` import `APIContext` directly so
// they can short-circuit on a null context. The mock must export the
// context with a null default; otherwise the `useContext(APIContext)`
// call inside those hooks would crash with `undefined is not iterable`
// (Codex P2).
void mock.module("@/browser/contexts/API", () => ({
  APIContext: createContext(null),
  useAPI: () => ({
    api: null,
    status: "error",
    error: "API unavailable",
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

// `GoalDefaultsModal` opens a Radix Dialog with portaled content that
// happy-dom can't render. The test never opens the modal — only that
// the trigger button exists — so a stub here keeps the form tree
// renderable without dragging the full Dialog primitive in.
void mock.module("@/browser/features/RightSidebar/GoalDefaultsModal", () => ({
  GoalDefaultsModal: () => null,
}));

// The goal-board sections subscribe to `workspace.getGoalBoard` via
// `useGoalBoard`. Existing tests render the GoalTab without an
// APIProvider, so the hook resolves to an empty board — but the
// component still mounts. Stub the renderer to keep the tree compact:
// these tests target the active-goal surface, not the board sections.
void mock.module("@/browser/features/RightSidebar/GoalBoardSections", () => ({
  GoalBoardSections: () => null,
}));

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
    // Completed goals now expose a "Reopen" affordance so the user can
    // revive a goal the agent marked done too eagerly. Pause / Mark
    // complete remain hidden because the goal already left the active
    // lifecycle state.
    expect(queryByLabelText("Pause goal")).toBeNull();
    expect(getByLabelText("Reopen goal")).toBeTruthy();
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
    // The inline editor's save button text is "Save" now (was "Save
    // objective") since the button sits inside the header instead of a
    // standalone panel with its own label.
    fireEvent.click(getByText("Save"));

    // The inline editor replaces the Edit button in the header while
    // editing is open, so the original `opener` DOM node is detached on
    // close. Re-query for the freshly-mounted button and assert focus
    // landed there — that's the user-visible behavior the tab targets.
    await waitFor(() => {
      const restoredOpener = getByLabelText("Edit goal objective");
      expect(document.activeElement).toBe(restoredOpener);
    });
    expect(onUpdateObjective).not.toHaveBeenCalled();

    // Real edit propagates the trimmed objective.
    const reopener = getByLabelText("Edit goal objective");
    fireEvent.click(reopener);
    const reopenedInput = getByLabelText("Goal objective") as HTMLTextAreaElement;
    fireEvent.input(reopenedInput, { target: { value: "  Refined objective  " } });
    fireEvent.click(getByText("Save"));

    await waitFor(() => expect(onUpdateObjective).toHaveBeenCalledWith("Refined objective"));
  });

  test("keeps the objective editor available for completed goals (user revive path)", () => {
    const { getByLabelText } = render(
      <GoalTab
        goal={goal({ status: "complete", completionSummary: "Wrapped up." })}
        onSetStatus={mock()}
        onClear={mock()}
        onUpdateObjective={mock()}
      />
    );

    // Completed goals stay editable now — the user must be able to revive
    // (and possibly rename) a goal the agent declared done too eagerly.
    // The backend's `validateStatusTransition` only blocks non-user
    // initiators from leaving `complete`, so the UI keeps the affordance
    // visible. See workspaceGoalService.test.ts for the backend coverage.
    expect(getByLabelText("Edit goal objective")).toBeTruthy();
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

  // The previous "renders completed-goals history with expandable detail"
  // test targeted the old in-tab `GoalHistorySection`. Completed-goal
  // rendering now lives in `GoalBoardSections` (which is stubbed in this
  // file because it reaches into the API context). Behavior is covered
  // end-to-end by `workspaceGoalService.test.ts`'s "goal board" suite
  // (auto-promote-on-complete + completed entries land under the
  // Completed section). No GoalTab-level replacement is needed.

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

    const { getByText, queryByText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} history={[entry]} />
    );

    // The empty-state placeholder still renders (the create form needs
    // `onCreate` to render — this test deliberately omits it to exercise
    // the placeholder branch). The history list itself has moved into
    // the (stubbed) `GoalBoardSections`, so we no longer assert on the
    // history entry's objective here — service-level coverage handles
    // the queue + completed view.
    expect(getByText("No goal is set for this workspace.")).toBeTruthy();
    expect(queryByText("Previously-cleared goal")).toBeNull();
  });

  test("empty state shows the create form when onCreate is provided", () => {
    const { getByLabelText, queryByText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={mock()} />
    );

    expect(getByLabelText("Create workspace goal")).toBeTruthy();
    expect(getByLabelText("Goal objective")).toBeTruthy();
    expect(getByLabelText("Goal budget")).toBeTruthy();
    expect(getByLabelText("Goal turn cap")).toBeTruthy();
    expect(getByLabelText("Set goal")).toBeTruthy();
    // The "No goal is set" placeholder is replaced by the form when
    // creation is wired through — keep both states from leaking.
    expect(queryByText("No goal is set for this workspace.")).toBeNull();
  });

  test("create form submits objective with no budget or turn cap by default", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    const objective = getByLabelText("Goal objective") as HTMLTextAreaElement;
    fireEvent.input(objective, { target: { value: "Ship the lifecycle slice" } });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    // Slash-command parity: blank budget / turn cap fields stay omitted so
    // the parent can apply `goalDefaults` (matching the palette + `/goal`
    // paths). Explicit `null` here would be a "no budget" clear, which is
    // a different intent.
    expect(onCreate).toHaveBeenCalledWith({ objective: "Ship the lifecycle slice" });
  });

  test("create form parses budget and turn cap inputs", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    fireEvent.input(getByLabelText("Goal objective") as HTMLTextAreaElement, {
      target: { value: "Spike on lifecycle events" },
    });
    fireEvent.input(getByLabelText("Goal budget") as HTMLInputElement, {
      target: { value: "$3.50" },
    });
    fireEvent.input(getByLabelText("Goal turn cap") as HTMLInputElement, {
      target: { value: "12" },
    });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    expect(onCreate).toHaveBeenCalledWith({
      objective: "Spike on lifecycle events",
      budgetCents: 350,
      turnCap: 12,
    });
  });

  test("create form rejects empty objective without calling onCreate", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText, getByRole } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    // Submit with the objective left blank. The form must not invoke
    // onCreate, and it must surface a localized error rather than letting
    // the slash-command-equivalent payload (empty objective) hit the
    // backend with `Goal objective cannot be empty`.
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("Goal objective is required");
    });
    expect(onCreate).not.toHaveBeenCalled();
  });

  test("create form rejects malformed budget without calling onCreate", async () => {
    const onCreate = mock(() => Promise.resolve(undefined));

    const { getByLabelText, getByRole } = render(
      <GoalTab goal={null} onSetStatus={mock()} onClear={mock()} onCreate={onCreate} />
    );

    fireEvent.input(getByLabelText("Goal objective") as HTMLTextAreaElement, {
      target: { value: "Valid objective" },
    });
    fireEvent.input(getByLabelText("Goal budget") as HTMLInputElement, {
      target: { value: "five bucks" },
    });
    fireEvent.click(getByLabelText("Set goal"));

    await waitFor(() => {
      const alert = getByRole("alert");
      expect(alert.textContent).toContain("$5");
    });
    expect(onCreate).not.toHaveBeenCalled();
  });
});
