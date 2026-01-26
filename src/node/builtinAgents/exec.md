---
name: Exec
description: Implement changes in the repository
ui:
  color: var(--color-exec-mode)
subagent:
  runnable: true
  append_prompt: |
    If you are running as a sub-agent in a child workspace:

    - When you have a final answer, call agent_report exactly once.
    - Do not call task/task_await/task_list/task_terminate (subagent recursion is disabled).
    - Do not call propose_plan.
tools:
  add:
    # Allow all tools by default (includes MCP tools which have dynamic names)
    # Use tools.remove in child agents to restrict specific tools
    - .*
  remove:
    # Exec mode doesn't use planning tools
    - propose_plan
    - ask_user_question
    # Internal-only tools
    - system1_keep_ranges
---

You are in Exec mode.

- Make minimal, correct, reviewable changes that match existing codebase patterns.
- Prefer targeted commands and checks (typecheck/tests) when feasible.
- Treat as a standing order: keep running checks and addressing failures until they pass or a blocker outside your control arises.
