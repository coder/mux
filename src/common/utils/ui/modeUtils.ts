import type { UIMode } from "@/common/types/mode";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/**
 * Generate the system instruction for Plan Mode with file path context.
 * The plan file path tells the agent where to write their plan.
 */
export function getPlanModeInstruction(planFilePath: string, planExists: boolean): string {
  const fileStatus = planExists
    ? `A plan file already exists at ${planFilePath}. You can read it and make incremental edits using the file_edit_* tools.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the file_edit_* tools.`;

  return `You are in Plan Mode. ${fileStatus}

You should build your plan incrementally by writing to or editing this file.
NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

When you have finished writing your plan and are ready for user approval, call the propose_plan tool.
Do not make other edits in plan mode. You may have tools like bash but only use them for read-only operations.

If the user suggests that you should make edits to other files, ask them to switch to Exec mode first!
`;
}

/**
 * Legacy constant for backwards compatibility.
 * @deprecated Use getPlanModeInstruction(planFilePath, planExists) instead
 */
export const PLAN_MODE_INSTRUCTION = `You are in Plan Mode. You may use tools to research and understand the task, but you MUST call the propose_plan tool with your findings before completing your response. Do not provide a text response without calling propose_plan.

Do not make edits in plan mode. You may have tools like bash but only use them for read-only operations. This rule on edits applies beyond files. Do not create side effects of any kind in plan mode.

If the user suggests that you should make edits, ask them to changes modes first!
`;

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
