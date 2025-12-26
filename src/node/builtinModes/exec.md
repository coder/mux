---
name: exec
label: Exec
description: Full execution mode with all tools enabled
icon: ⚡
color: var(--color-exec-mode)
toolPolicy:
  - regex: propose_plan
    action: disable
---

Execute tasks with full tool access. All file editing, bash commands, and sub-agent capabilities are available.
