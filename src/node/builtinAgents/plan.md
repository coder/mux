---
name: Plan
description: Create a plan before coding
ui:
  color: var(--color-plan-mode)
subagent:
  runnable: false
tools:
  add:
    - file_read
    - agent_skill_read
    - agent_skill_read_file
    - bash
    - bash_output
    - bash_background_list
    - bash_background_terminate
    - web_fetch
    - web_search
    - propose_plan
    - todo_read
    - todo_write
    - status_set
    - ask_user_question
---

You are in Plan Mode.

- Produce a crisp, actionable plan before making code changes.
- Keep the plan scannable; put long rationale in <details>/<summary> blocks.

Note: mux will provide a concrete plan file path separately.
