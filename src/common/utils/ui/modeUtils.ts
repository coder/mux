import type { UIMode } from "@/common/types/mode";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/**
 * Generate the plan file path context for Plan Mode.
 *
 * NOTE: The main plan mode behavioral instructions are in src/node/builtinAgents/plan.md.
 * This function only provides the dynamic plan file path context (which file to write to).
 */
export function getPlanModeInstruction(planFilePath: string, planExists: boolean): string {
  if (planExists) {
    return `Plan file path: ${planFilePath}

A plan file already exists. First, read it to determine if it's relevant to the current request. If the current request is unrelated to the existing plan, delete the file and start fresh. If relevant, make incremental edits using the file_edit_* tools.`;
  }

  return `Plan file path: ${planFilePath}

No plan file exists yet. Create your plan at this path using the file_edit_* tools.`;
}

/**
 * Lightweight plan file context for non-plan modes.
 *
 * We intentionally include only the path (not the contents) to avoid prompt bloat.
 */
export function getPlanFileHint(planFilePath: string, planExists: boolean): string | null {
  if (!planExists) return null;

  return `A plan file exists at: ${planFilePath}. If a previously developed plan is relevant to the current work, read it and follow it. Otherwise, ignore it.`;
}

/**
 * Get the tool policy for a given UI mode.
 * In plan mode, file_edit_* tools remain enabled (agent needs them to write plan file),
 * but strict path enforcement in file_edit_operation.ts restricts edits to only the plan file.
 */
export function modeToToolPolicy(mode: UIMode): ToolPolicy {
  if (mode === "plan") {
    return [
      { regex_match: "propose_plan", action: "enable" },
      // file_edit_* stays enabled - agent needs it to write plan file
      // Path restriction is enforced in file_edit_operation.ts
    ];
  }

  // exec mode
  return [{ regex_match: "propose_plan", action: "disable" }];
}
