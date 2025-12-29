import type { AgentDefinitionPackage } from "@/common/types/agentDefinition";

const BUILT_IN_PACKAGES: AgentDefinitionPackage[] = [
  {
    id: "plan",
    scope: "built-in",
    frontmatter: {
      name: "Plan",
      description: "Create a plan before coding",
      permissionMode: "default",
      subagent: { runnable: false },
      policy: { base: "plan" },
    },
    body: [
      "You are in Plan Mode.",
      "",
      "- Produce a crisp, actionable plan before making code changes.",
      "- Keep the plan scannable; put long rationale in <details>/<summary> blocks.",
      "",
      "Note: mux will provide a concrete plan file path separately.",
    ].join("\n"),
  },
  {
    id: "exec",
    scope: "built-in",
    frontmatter: {
      name: "Exec",
      description: "Implement changes in the repository",
      permissionMode: "default",
      subagent: { runnable: true },
      policy: { base: "exec" },
    },
    body: [
      "You are in Exec mode.",
      "",
      "- Make minimal, correct, reviewable changes that match existing codebase patterns.",
      "- Prefer targeted commands and checks (typecheck/tests) when feasible.",
      "",
      "If you are running as a sub-agent in a child workspace:",
      "- When you have a final answer, call agent_report exactly once.",
      "- Do not call task/task_await/task_list/task_terminate (subagent recursion is disabled).",
      "- Do not call propose_plan.",
    ].join("\n"),
  },
  {
    id: "compact",
    scope: "built-in",
    frontmatter: {
      name: "Compact",
      description: "History compaction (internal)",
      ui: { hidden: true },
      subagent: { runnable: false },
      policy: { base: "compact" },
    },
    body: "You are running a compaction/summarization pass. Do not call tools.",
  },
  {
    id: "explore",
    scope: "built-in",
    frontmatter: {
      name: "Explore",
      description: "Read-only repository exploration",
      ui: { hidden: true },
      subagent: { runnable: true },
      policy: {
        base: "exec",
        tools: {
          only: [
            "file_read",
            "bash",
            "bash_output",
            "bash_background_list",
            "bash_background_terminate",
            "web_fetch",
            "web_search",
            "google_search",
            "agent_report",
          ],
        },
      },
    },
    body: [
      "You are an Explore sub-agent running inside a child workspace.",
      "",
      "Goals:",
      "- Explore the repository to answer the prompt using read-only investigation.",
      "- Return concise, actionable findings (paths, symbols, callsites, and facts).",
      "",
      "Rules:",
      "=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===",
      "- You MUST NOT create, edit, delete, move, or copy files.",
      "- You MUST NOT create temporary files anywhere (including /tmp).",
      "- You MUST NOT use redirect operators (>, >>, |) or heredocs to write to files.",
      "- You MUST NOT run commands that change system state (rm, mv, cp, mkdir, touch, git add/commit, installs, etc.).",
      "- Use bash only for read-only operations (rg, ls, cat, git diff/show/log, etc.).",
      "- Do not call task/task_await/task_list/task_terminate (subagent recursion is disabled).",
      "",
      "Reporting:",
      "- When you have a final answer, call agent_report exactly once.",
      "- Do not call agent_report until you have completed the assigned task and integrated all relevant findings.",
    ].join("\n"),
  },
];

export function getBuiltInAgentDefinitions(): AgentDefinitionPackage[] {
  return BUILT_IN_PACKAGES;
}
