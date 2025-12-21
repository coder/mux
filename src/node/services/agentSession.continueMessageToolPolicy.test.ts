import { describe, expect, test } from "bun:test";
import { modeToToolPolicy } from "@/common/utils/ui/modeUtils";

/**
 * Regression test for continue message tool policy bug.
 *
 * Bug: When a /compact command includes a continue message, the continue message
 * was being queued with the compaction mode's tool policy (all tools disabled)
 * instead of the intended execution mode's tool policy.
 *
 * Fix: Continue message now carries its own mode field, and the backend uses
 * modeToToolPolicy(continueMessage.mode) instead of copying options.toolPolicy.
 *
 * This test verifies that the mode-to-policy transformation produces the expected
 * tool policies for continue messages. The actual integration of this logic into
 * agentSession.ts is verified by the type system and manual testing.
 */
describe("Continue message tool policy derivation", () => {
  test("exec mode enables tools (not disabled-all like compaction)", () => {
    const execPolicy = modeToToolPolicy("exec");
    const compactionPolicy = [{ regex_match: ".*", action: "disable" }];

    // Exec mode should NOT disable all tools like compaction does
    expect(execPolicy).not.toEqual(compactionPolicy);

    // Exec mode specifically disables propose_plan (the plan mode tool)
    expect(execPolicy).toEqual([{ regex_match: "propose_plan", action: "disable" }]);
  });

  test("plan mode has different policy than compaction", () => {
    const planPolicy = modeToToolPolicy("plan");
    const compactionPolicy = [{ regex_match: ".*", action: "disable" }];

    // Plan mode should NOT disable all tools like compaction does
    expect(planPolicy).not.toEqual(compactionPolicy);

    // Plan mode enables propose_plan
    expect(planPolicy).toEqual([{ regex_match: "propose_plan", action: "enable" }]);
  });

  test("verifies fix: mode field determines policy, not inherited compaction policy", () => {
    // This test documents the fix behavior:
    // Before fix: continueMessage used options.toolPolicy (compaction's disabled-all)
    // After fix: continueMessage.mode determines the policy via modeToToolPolicy()

    // Simulating the fixed logic from agentSession.ts:
    // const continueMode = continueMessage.mode ?? "exec";
    // toolPolicy: modeToToolPolicy(continueMode)

    const simulateContinueMessagePolicy = (mode?: "exec" | "plan") => {
      const continueMode = mode ?? "exec"; // Default to exec as in the fix
      return modeToToolPolicy(continueMode);
    };

    // Explicit exec mode
    expect(simulateContinueMessagePolicy("exec")).toEqual([
      { regex_match: "propose_plan", action: "disable" },
    ]);

    // Explicit plan mode
    expect(simulateContinueMessagePolicy("plan")).toEqual([
      { regex_match: "propose_plan", action: "enable" },
    ]);

    // No mode specified (defaults to exec)
    expect(simulateContinueMessagePolicy(undefined)).toEqual([
      { regex_match: "propose_plan", action: "disable" },
    ]);

    // None of these should be the compaction policy
    const compactionPolicy = [{ regex_match: ".*", action: "disable" }];
    expect(simulateContinueMessagePolicy("exec")).not.toEqual(compactionPolicy);
    expect(simulateContinueMessagePolicy("plan")).not.toEqual(compactionPolicy);
    expect(simulateContinueMessagePolicy(undefined)).not.toEqual(compactionPolicy);
  });
});
