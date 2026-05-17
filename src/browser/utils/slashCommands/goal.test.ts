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

  test("parses a leading budget flag on goal creation", () => {
    expect(parseCommand('/goal -b $5 "ship the slice"')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand('/goal -b $5.00 "ship the slice"')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    // Bare numbers accept dollar amounts (Coder-agents-review P3 DEREM-21).
    // `5` and `5.00` parse identically to `$5` / `$5.00` so the GoalTab
    // editor and the slash command behave the same.
    expect(parseCommand("/goal -b 5 ship the slice")).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand("/goal -b 5.00 ship the slice")).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
    expect(parseCommand("/goal -b 500c ship the slice")).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
    });
  });

  test("preserves a single newline between header objective and body", () => {
    expect(parseCommand("/goal Ship it\n- bullet")).toEqual({
      type: "goal-set",
      objective: "Ship it\n- bullet",
    });
  });

  test("uses leading budget flag while preserving flag-looking body prose", () => {
    expect(parseCommand("/goal -b $5\nShip it\n--budget stays prose\n- bullet")).toEqual({
      type: "goal-set",
      objective: "Ship it\n--budget stays prose\n- bullet",
      budgetCents: 500,
    });
  });

  test("treats non-leading flag-looking tokens as goal text", () => {
    expect(parseCommand('/goal "ship the slice" --budget $5')).toEqual({
      type: "goal-set",
      objective: "ship the slice --budget $5",
    });
    expect(parseCommand("/goal ship the slice -b 5")).toEqual({
      type: "goal-set",
      objective: "ship the slice -b 5",
    });
    expect(parseCommand("/goal --no-budget ship the slice")).toEqual({
      type: "goal-set",
      objective: "--no-budget ship the slice",
    });
    expect(parseCommand("/goal ship the slice --no-budget")).toEqual({
      type: "goal-set",
      objective: "ship the slice --no-budget",
    });
    expect(parseCommand('/goal "ship the slice" --turns 25')).toEqual({
      type: "goal-set",
      objective: "ship the slice --turns 25",
    });
    expect(parseCommand("/goal --bogus\nBody")).toEqual({
      type: "goal-set",
      objective: "--bogus\nBody",
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

  test("parses turn cap in the leading flag prefix", () => {
    expect(parseCommand('/goal --turns 25 "ship the slice"')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      turnCap: 25,
    });
    expect(parseCommand('/goal -b $5 --turns 25 "ship the slice"')).toEqual({
      type: "goal-set",
      objective: "ship the slice",
      budgetCents: 500,
      turnCap: 25,
    });
  });

  test("rejects invalid leading flags", () => {
    expect(parseCommand("/goal -b abc ship")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand("/goal -b")).toMatchObject({
      type: "command-missing-args",
      command: "goal",
    });
    expect(parseCommand("/goal --turns 0 ship")).toMatchObject({
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
  });

  test("rejects invalid budget update command", () => {
    // Non-numeric / malformed input still rejects after DEREM-21 — the
    // unified parser only loosened the dollar-prefix requirement.
    expect(parseCommand("/goal budget --no-budget")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
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
