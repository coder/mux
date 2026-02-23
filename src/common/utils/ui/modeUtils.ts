/**
 * Generate the system instruction for Plan Mode with file path context.
 *
 * This provides comprehensive plan mode behavioral instructions that are
 * injected for ALL plan-like agents (built-in Plan agent or custom agents
 * that enable propose_plan). The instructions are injected as
 * <additional-instructions> in the system prompt.
 */
export function getPlanModeInstruction(planFilePath: string, planExists: boolean): string {
  const exactPlanPathRule = planFilePath.startsWith("~/")
    ? "You must use the plan file path exactly as shown (including the leading `~/`); do not expand `~` or use alternate paths that resolve to the same file."
    : "You must use the plan file path exactly as shown; do not rewrite it or use alternate paths that resolve to the same file.";
  const fileStatus = planExists
    ? `A plan file already exists at ${planFilePath}. First, read it to determine if it's relevant to the current request. After any compaction/context reset (when earlier messages are replaced by a summary), re-read the plan before continuing. If the current request is unrelated to the existing plan, delete the file and start fresh. If relevant, make incremental edits using the file_edit_* tools.`
    : `No plan file exists yet. You should create your plan at ${planFilePath} using the file_edit_* tools.`;

  return `Plan file path: ${planFilePath} (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)

${fileStatus}

Build your plan incrementally by writing to or editing this file.
NOTE: The plan file is the only file you are allowed to edit. Other than that you may only take READ-ONLY actions.
${exactPlanPathRule}

Keep the plan crisp and focused on actionable recommendations:
- Put historical context, alternatives considered, or lengthy rationale into collapsible \`<details>/<summary>\` blocks so the core plan stays scannable.
- When listing implementation details, include **reasonably sized** code snippets (fenced code blocks) for key changes—enough to remove ambiguity, but avoid whole-file dumps. Use ellipses (...) to omit unrelated context.
- **Aggressively prune completed or irrelevant content.** When sections become outdated—tasks finished, approaches abandoned, questions answered—delete them entirely rather than moving them to an appendix or marking them done. The plan should reflect current state, not accumulate history.
- Each revision should leave the plan shorter or unchanged in scope, never longer unless the actual work grew.

If you need investigation (codebase exploration, tracing callsites, locating patterns, feasibility checks) before you can produce a good plan, delegate it to Explore sub-agents via the \`task\` tool:
- In Plan Mode, you MUST ONLY spawn \`agentId: "explore"\` tasks. Do NOT spawn \`agentId: "exec"\` tasks in Plan Mode.
- Use \`agentId: "explore"\` for read-only repo/code exploration and optional web lookups when relevant.
- In each task prompt, specify explicit deliverables (what questions to answer, what files/symbols to locate, and the exact output format you want back).
- Prefer running multiple Explore tasks in parallel with \`run_in_background: true\`, then use \`task_await\` (optionally with \`task_ids\`) until all spawned tasks are \`completed\`.
- Trust Explore sub-agent reports as authoritative for repo facts (paths/symbols/callsites). Do not redo the same investigation yourself; only re-check if the report is ambiguous or contradicts other evidence.
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
 * Lightweight plan file context for non-plan modes.
 *
 * We intentionally include only the path (not the contents) to avoid prompt bloat.
 */
export function getPlanFileHint(planFilePath: string, planExists: boolean): string | null {
  if (!planExists) return null;

  return `A plan file exists at: ${planFilePath}. If the plan is already included in the chat history (e.g., after “Replace all chat history with this plan” or a <plan> block from an agent transition), do NOT re-read the plan file. Otherwise, if you are continuing previous work—especially after any compaction/context reset (when earlier messages are replaced by a summary)—read it before proceeding and use it as the source of truth for what remains. If it is unrelated to the current request, ignore it.`;
}
