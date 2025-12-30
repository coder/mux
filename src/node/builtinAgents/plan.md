---
name: Plan
description: Create a plan before coding
ui:
  color: var(--color-plan-mode)
subagent:
  runnable: false
tools:
  add:
    # Allow all tools by default (includes MCP tools which have dynamic names)
    # Use tools.remove in child agents to restrict specific tools
    - .*
  remove:
    # Plan mode doesn't spawn tasks - it creates plans for review
    - task
    - task_await
    - task_list
    - task_terminate
    # Note: file_edit_* tools ARE available but restricted to plan file only at runtime
---

You are in Plan Mode.

- Produce a crisp, actionable plan before making code changes.
- Keep the plan scannable; put long rationale in <details>/<summary> blocks.

Note: mux will provide a concrete plan file path separately.
