import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { installDom } from "../../../../tests/ui/dom";

import { ActiveGoalsWarningToast } from "./ActiveGoalsWarningToast";

describe("ActiveGoalsWarningToast", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("fires once on a rising edge above three active goals", async () => {
    const { queryByRole, rerender } = render(<ActiveGoalsWarningToast activeGoalCount={3} />);

    expect(queryByRole("status")).toBeNull();

    rerender(<ActiveGoalsWarningToast activeGoalCount={4} />);
    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));

    rerender(<ActiveGoalsWarningToast activeGoalCount={5} />);
    expect(queryByRole("status")?.textContent).toContain("4 active goals");
  });

  test("re-arms after the active-goal count falls to three", async () => {
    const { queryByRole, rerender } = render(<ActiveGoalsWarningToast activeGoalCount={4} />);

    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));

    rerender(<ActiveGoalsWarningToast activeGoalCount={3} />);
    await waitFor(() => expect(queryByRole("status")).toBeNull());

    rerender(<ActiveGoalsWarningToast activeGoalCount={4} />);
    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));
  });

  test("announces warnings politely", async () => {
    const { getByRole } = render(<ActiveGoalsWarningToast activeGoalCount={4} />);

    await waitFor(() => expect(getByRole("status").getAttribute("aria-live")).toBe("polite"));
  });

  test("does not fire when the GOALS experiment is disabled", () => {
    // Coder-agents-review P3 DEREM-49: pin the experiment-off short-circuit
    // so a regression that removed the `enabled === false` guard would fail.
    // Without it, users who toggled the experiment off mid-session would get
    // spurious warnings whenever active goals exceed the threshold.
    const { queryByRole } = render(<ActiveGoalsWarningToast activeGoalCount={5} enabled={false} />);

    expect(queryByRole("status")).toBeNull();
  });

  test("clears any showing toast when the experiment is toggled off mid-session", async () => {
    // The experiment-off branch also clears a *currently showing* warning,
    // not just suppresses new ones. Render with enabled=true above the
    // threshold (which fires the toast), then flip to enabled=false and
    // assert the toast disappears.
    const { queryByRole, rerender } = render(<ActiveGoalsWarningToast activeGoalCount={4} />);
    await waitFor(() => expect(queryByRole("status")?.textContent).toContain("4 active goals"));

    rerender(<ActiveGoalsWarningToast activeGoalCount={4} enabled={false} />);
    await waitFor(() => expect(queryByRole("status")).toBeNull());
  });
});
