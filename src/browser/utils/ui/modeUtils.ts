import type { UIMode } from "@/common/types/mode";
import type { ToolPolicy } from "@/utils/tools/toolPolicy";

/**
 * System instruction for Plan Mode
 * Extracted as constant to avoid duplication across sendMessageOptions builders
 */
export const PLAN_MODE_INSTRUCTION = `You are in Plan Mode. You may use tools to research and understand the task, but you MUST call the propose_plan tool with your findings before completing your response. Do not provide a text response without calling propose_plan.

Do not make edits in plan mode. You may have tools like bash but only use them for read-only operations. This rule on edits applies beyond files. Do not create side effects of any kind in plan mode.

If the user suggests that you should make edits, ask them to changes modes first! 
`;

/**
 * Get the tool policy for a given UI mode
 */
export function modeToToolPolicy(mode: UIMode): ToolPolicy {
  if (mode === "plan") {
    return [
      { regex_match: "file_edit_.*", action: "disable" },
      { regex_match: "propose_plan", action: "enable" },
    ];
  }

  // exec mode
  return [
    { regex_match: "propose_plan", action: "disable" },
    { regex_match: "file_edit_.*", action: "enable" },
  ];
}
