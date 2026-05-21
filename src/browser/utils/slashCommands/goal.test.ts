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

  // ────────────────────────────────────────────────────────────────
  // /goal --compact <value>
  //
  // Mirrors the inline editor / create-form vocabulary so the slash,
  // palette, and tab paths agree on what the user can type. Order-
  // sensitive: must appear after `--turns` (or after `-b`) and before
  // the objective.
  // ────────────────────────────────────────────────────────────────
  test("parses --compact with an integer percent", () => {
    expect(parseCommand("/goal --compact 50 Ship the slice")).toEqual({
      type: "goal-set",
      objective: "Ship the slice",
      autoCompactionThresholdPct: 50,
    });
    // `100` (per-goal disabled) is distinct from "off" but both must
    // resolve to the same value so /goal --compact 100 and /goal
    // --compact off produce identical persisted state.
    expect(parseCommand("/goal --compact 100 Long context")).toEqual({
      type: "goal-set",
      objective: "Long context",
      autoCompactionThresholdPct: 100,
    });
  });

  test("parses --compact off / disable / disabled as 100 (per-goal disabled)", () => {
    for (const word of ["off", "disable", "disabled"]) {
      expect(parseCommand(`/goal --compact ${word} Stay long`)).toEqual({
        type: "goal-set",
        objective: "Stay long",
        autoCompactionThresholdPct: 100,
      });
    }
  });

  test("parses --compact default / none / clear as null (clear override)", () => {
    for (const word of ["default", "none", "clear"]) {
      expect(parseCommand(`/goal --compact ${word} Use workspace setting`)).toEqual({
        type: "goal-set",
        objective: "Use workspace setting",
        autoCompactionThresholdPct: null,
      });
    }
  });

  test("accepts a trailing percent sign", () => {
    expect(parseCommand("/goal --compact 75% Tight context")).toEqual({
      type: "goal-set",
      objective: "Tight context",
      autoCompactionThresholdPct: 75,
    });
  });

  test("composes with -b and --turns in the documented order", () => {
    // The parser walks `-b → --turns → --compact → objective` exactly
    // in that sequence; pin that order here so a future refactor can't
    // silently break it.
    expect(parseCommand("/goal -b $5 --turns 10 --compact 60 Run the full plan")).toEqual({
      type: "goal-set",
      objective: "Run the full plan",
      budgetCents: 500,
      turnCap: 10,
      autoCompactionThresholdPct: 60,
    });
  });

  test("rejects --compact with invalid values", () => {
    expect(parseCommand("/goal --compact 200 oops")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    expect(parseCommand("/goal --compact abc oops")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
    // Missing value falls through to "abc" as the rejected token —
    // the test below uses an explicit dangling flag form.
    expect(parseCommand("/goal --compact -1 oops")).toMatchObject({
      type: "command-invalid-args",
      command: "goal",
    });
  });

  test("treats non-leading --compact tokens as goal text", () => {
    // Mirrors the same defensive behavior `--budget` already has —
    // only the leading flag prefix is command syntax; anything after
    // the objective starts is preserved verbatim.
    expect(parseCommand("/goal Ship it --compact 50 stays prose")).toEqual({
      type: "goal-set",
      objective: "Ship it --compact 50 stays prose",
    });
  });
});
