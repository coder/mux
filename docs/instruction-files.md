---
title: Instruction Files
description: Configure agent behavior with AGENTS.md files
---

## Overview

mux layers instructions from two locations:

1. `~/.mux/AGENTS.md` (+ optional `AGENTS.local.md`) — global defaults
2. `<workspace>/AGENTS.md` (+ optional `AGENTS.local.md`) — workspace-specific context

Priority within each location: `AGENTS.md` → `AGENT.md` → `CLAUDE.md` (first match wins). If the base file is found, mux also appends `AGENTS.local.md` from the same directory when present.

<Info>mux strips HTML-style markdown comments (`<!-- ... -->`) from instruction files before sending them to the model. Use these comments for editor-only metadata—they will not reach the agent.</Info>

## Scoped Instructions

mux supports **Scoped Instructions** that activate only in specific contexts. You define them using special headings in your instruction files:

- `Mode: <mode>` — Active only in specific interaction modes (e.g., plan, exec).
- `Model: <regex>` — Active only for specific models (e.g., GPT-4, Claude).
- `Tool: <tool_name>` — Appended to the description of specific tools.

### General Rules

- **Precedence**: Workspace instructions (`<workspace>/AGENTS.md`) are checked first, then global instructions (`~/.mux/AGENTS.md`).
- **First Match Wins**: Only the _first_ matching section found is used. Overriding global defaults is as simple as defining the same section in your workspace.
- **Isolation**: These sections are **stripped** from the general `<custom-instructions>` block. Their content is injected only where it belongs (e.g., into a specific tool's description or a special XML tag).
- **Boundaries**: A section's content includes everything until the next heading of the same or higher level.

---

### Mode Prompts

Use mode-specific sections to optimize context and customize behavior for specific workflow stages. The active mode's content is injected via a `<mode>` tag.

**Syntax**: `Mode: <mode>` (case-insensitive)

**Example**:

```markdown
# General Instructions

- Be concise

## Mode: Plan

When planning:

- Focus on goals and trade-offs
- Propose alternatives with pros/cons

## Mode: Compact

- Preserve key decisions
- Be extremely concise
```

**Available modes**:

- **exec** (default) — Normal operations.
- **plan** — Active in Plan Mode.
- **compact** — Used during `/compact` to guide history summarization.

### Model Prompts

Scope instructions to specific models or families using regex matching. The matched content is injected via a `<model-...>` tag.

**Syntax**: `Model: <regex>`

- Regexes are case-insensitive by default.
- Use `/pattern/flags` for custom flags (e.g., `/openai:.*codex/i`).

**Example**:

```markdown
## Model: sonnet

Be terse and to the point.

## Model: openai:.\*codex

Use status reporting tools every few minutes.
```

### Tool Prompts

Customize how the AI uses specific tools by appending instructions to their descriptions.

**Syntax**: `Tool: <tool_name>`

- Tool names must match exactly (case-insensitive).
- Only tools available for the active model are augmented.

**Example**:

```markdown
## Tool: bash

- Use `rg` instead of `grep` for file searching

## Tool: file_edit_replace_string

- Run `prettier --write` after editing files

# Tool: status_set

- Set status url to the Pull Request once opened
```

**Available tools**: `bash`, `file_read`, `file_edit_replace_string`, `file_edit_insert`, `propose_plan`, `todo_write`, `todo_read`, `status_set`, `web_search`.

## Practical layout

```
~/.mux/
  AGENTS.md          # Global instructions
  AGENTS.local.md    # Personal tweaks (gitignored)

my-project/
  AGENTS.md          # Project instructions (may include "Mode: Plan", etc.)
  AGENTS.local.md    # Personal tweaks (gitignored)
```
