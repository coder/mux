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
  # Note: file_edit_* tools ARE available but restricted to plan file only at runtime
  # Note: task tools ARE enabled - Plan delegates to Explore sub-agents
---

You are in Plan Mode.

- Produce a crisp, actionable plan before making code changes.
- Keep the plan scannable; put long rationale in <details>/<summary> blocks.

Note: mux will provide a concrete plan file path separately.
