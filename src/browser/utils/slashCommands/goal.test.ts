import { describe, expect, test } from "bun:test";
import { parseCommand } from "./parser";

describe("/goal slash command", () => {
  test("parses bare goal", () => {
    expect(parseCommand("/goal")).toEqual({ type: "goal-show" });
  });

  test("parses clear", () => {
    expect(parseCommand("/goal clear")).toEqual({ type: "goal-clear" });
  });

  test("parses objective preserving spaces inside quotes", () => {
    expect(parseCommand('/goal "ship the slice"')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
    });
  });

  test("parses multiline objective with Markdown bullets", () => {
    expect(parseCommand("/goal Implement PRD\n\nRead first:\n- CONTEXT.md\n- PRD.md")).toEqual({
      type: "goal-set",
      objective: "Implement PRD\n\nRead first:\n- CONTEXT.md\n- PRD.md",
    });
  });

  test("parses budget flags on goal creation", () => {
    expect(parseCommand('/goal "ship the slice" --budget $5')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand('/goal "ship the slice" --budget $5.00')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    // Bare numbers accept dollar amounts (Coder-agents-review P3 DEREM-21).
    // `5` and `5.00` parse identically to `$5` / `$5.00` so the GoalTab
    // editor and the slash command behave the same.
    expect(parseCommand('/goal "ship the slice" --budget 5')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand('/goal "ship the slice" --budget 5.00')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand('/goal "ship the slice" --budget 500c')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand('/goal "ship the slice" --no-budget')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: null,
    });
  });

  test("preserves a single newline between header objective and body", () => {
    expect(parseCommand("/goal Ship it\n- bullet")).toEqual({
      type: "goal-set",
      objective: "Ship it\n- bullet",
    });
  });

  test("parses header flags while preserving flag-looking body prose", () => {
    expect(
      parseCommand("/goal --budget $5 --turns 25\nShip it\n--budget stays prose\n- bullet")
    ).toEqual({
      type: "goal-set",
      objective: "Ship it\n--budget stays prose\n- bullet",
      budgetCents: 500,
      turnCap: 25,
    });
  });

  test("rejects unknown goal creation flags as known-command flag errors", () => {
    expect(parseCommand("/goal --bogus\nBody")).toMatchObject({
      type: "command-unknown-flag",
      command: "goal",
      flag: "--bogus",
    });
  });

  test("rejects lifecycle commands with multiline bodies", () => {
    expect(parseCommand("/goal clear\nActually a long objective")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand("/goal complete\nActually a long objective")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
  });

  test("parses turn cap on goal creation", () => {
    expect(parseCommand('/goal "ship the slice" --turns 25')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      turnCap: 25,
    });
  });

  test("rejects invalid budget and turn flags", () => {
    // DEREM-21 unified the parser; bare numbers (e.g. `--budget 5`) are
    // now valid. The remaining invalid forms are: non-numeric garbage,
    // conflicting `--budget` + `--no-budget`, and zero/negative turn caps.
    expect(parseCommand('/goal "ship" --budget abc')).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand('/goal "ship" --budget $5 --no-budget')).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand('/goal "ship" --turns 0')).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
  });

  test("parses pause and resume lifecycle commands", () => {
    expect(parseCommand("/goal pause")).toEqual({ type: "goal-pause" });
    expect(parseCommand("/goal resume")).toEqual({ type: "goal-resume" });
  });

  test("parses complete lifecycle commands", () => {
    expect(parseCommand("/goal complete")).toEqual({ type: "goal-complete" });
    expect(parseCommand('/goal complete --summary "Verified and shipped"')).toEqual({
      type: "goal-complete",
      summary: "Verified and shipped",
    });
  });

  test("parses budget update command", () => {
    expect(parseCommand("/goal budget $5")).toEqual({ type: "goal-budget", budgetCents: 500 });
    expect(parseCommand("/goal budget $5.00")).toEqual({ type: "goal-budget", budgetCents: 500 });
    // Bare-number form unified with the GoalTab editor (DEREM-21).
    expect(parseCommand("/goal budget 5")).toEqual({ type: "goal-budget", budgetCents: 500 });
    expect(parseCommand("/goal budget 5.00")).toEqual({ type: "goal-budget", budgetCents: 500 });
    expect(parseCommand("/goal budget 500c")).toEqual({ type: "goal-budget", budgetCents: 500 });
    expect(parseCommand("/goal budget --no-budget")).toEqual({
      type: "goal-budget",
      budgetCents: null,
    });
  });

  test("rejects invalid budget update command", () => {
    // Non-numeric / malformed input still rejects after DEREM-21 — the
    // unified parser only loosened the dollar-prefix requirement.
    expect(parseCommand("/goal budget abc")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand("/goal budget 5.000")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
  });
});
