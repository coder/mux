import type { UIMode } from "@/common/types/mode";
import type { ToolPolicy } from "@/common/utils/tools/toolPolicy";

/**
 * Generate the system instruction for Plan Mode with file path context.
 * The plan file path tells the agent where to write their plan.
 */
export function getPlanModeInstruction(planFilePath: string, planExists: boolean): string {
  const fileStatus = planExists
    ? `A plan file already exists at ${planFilePath}. First, read it to determine if it's relevant to the current request. If the current request is unrelated to the existing plan, delete the file and start fresh. If relevant, make incremental edits using the file_edit_* tools.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the file_edit_* tools.`;

  return `You are in Plan Mode. ${fileStatus}

You should build your plan incrementally by writing to or editing this file.
NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

Keep the plan crisp and focused on actionable recommendations. Put historical context, alternatives considered, or lengthy rationale into collapsible \`<details>/<summary>\` blocks so the core plan stays scannable.

If you need investigation (codebase exploration, tracing callsites, locating patterns, feasibility checks) before you can produce a good plan, delegate it to Explore sub-agents via the \`task\` tool:
- In Plan Mode, you MUST ONLY spawn \`subagent_type: "explore"\` tasks. Do NOT spawn \`subagent_type: "exec"\` tasks in Plan Mode.
- Use \`subagent_type: "explore"\` for read-only repo/code exploration and optional web lookups when relevant.
- In each task prompt, specify explicit deliverables (what questions to answer, what files/symbols to locate, and the exact output format you want back).
- Prefer running multiple Explore tasks in parallel with \`run_in_background: true\`, then use \`task_await\` (optionally with \`task_ids\`) until all spawned tasks are \`completed\`.
- While Explore tasks run, do NOT perform broad repo exploration yourself. Wait for the reports, then synthesize the plan in this session.
- Do NOT call \`propose_plan\` until you have awaited and incorporated sub-agent reports.

If you need clarification from the user before you can finalize the plan, you MUST use the ask_user_question tool.
- Do not ask questions in a normal chat message.
- Do not include an "Open Questions" section in the plan.
- Ask up to 4 questions at a time (each with 2–4 options; "Other" is always available for free-form input).
- After you receive answers, update the plan file and only then call propose_plan.
- After calling propose_plan, do not repeat/paste the plan contents in chat; the UI already renders the full plan.
- After calling propose_plan, do not say "the plan is ready at <path>" or otherwise mention the plan file location; it's already shown in the Plan UI.

When you have finished writing your plan and are ready for user approval, call the propose_plan tool.
Do not make other edits in plan mode. You may have tools like bash but only use them for read-only operations.
Read-only bash means: no redirects/heredocs, no rm/mv/cp/mkdir/touch, no git add/commit, and no dependency installs.

If the user suggests that you should make edits to other files, ask them to switch to Exec mode first!
`;
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
