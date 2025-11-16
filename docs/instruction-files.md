# Instruction Files

## Overview

mux layers instructions from two locations:

1. `~/.mux/AGENTS.md` (+ optional `AGENTS.local.md`) — global defaults
2. `<workspace>/AGENTS.md` (+ optional `AGENTS.local.md`) — workspace-specific context

Priority within each location: `AGENTS.md` → `AGENT.md` → `CLAUDE.md` (first match wins). If the base file is found, mux also appends `AGENTS.local.md` from the same directory when present.

> **Note:** mux strips HTML-style markdown comments (`<!-- ... -->`) from instruction files before sending them to the model. Use these comments for editor-only metadata—they will not reach the agent.

## Mode Prompts

> Use mode-specific sections to optimize context and customize the behavior specific modes.

mux reads mode context from sections inside your instruction files. Add a heading titled:

- `Mode: <mode>` (case-insensitive), at any heading level (`#` .. `######`)

Rules:

- Workspace instructions are checked first, then global instructions
- The first matching section wins (at most one section is used)
- The section's content is everything until the next heading of the same or higher level
- Mode sections are stripped from the general `<custom-instructions>` block; only the active mode's content is re-sent via its `<mode>` tag.
- Missing sections are ignored (no error)

<!-- Note to developers: This behavior is implemented in src/services/systemMessage.ts (search for extractModeSection). Keep this documentation in sync with code changes. -->

Example (in either `~/.mux/AGENTS.md` or `my-project/AGENTS.md`):

```markdown
# General Instructions

- Be concise
- Prefer TDD

## Mode: Plan

When planning:

- Focus on goals, constraints, and trade-offs
- Propose alternatives with pros/cons
- Defer implementation detail unless asked

## Mode: Compact

When compacting conversation history:

- Preserve key decisions and their rationale
- Keep code snippets that are still relevant
- Maintain context about ongoing tasks
- Be extremely concise—prioritize information density
```

### Available modes

- **exec** - Default mode for normal operations
- **plan** - Activated when the user toggles plan mode in the UI
- **compact** - Automatically used during `/compact` operations to guide how the AI summarizes conversation history

Customizing the `compact` mode is particularly useful for controlling what information is preserved during automatic history compaction.

## Model Prompts

Similar to modes, mux reads headings titled `Model: <regex>` to scope instructions to specific models or families. The `<regex>` is matched against the full model identifier (for example, `openai:gpt-5.1-codex`).

Rules:

- Workspace instructions are evaluated before global instructions; the first matching section wins.
- Regexes are case-insensitive by default. Use `/pattern/flags` syntax to opt into custom flags (e.g., `/openai:.*codex/i`).
- Invalid regex patterns are ignored instead of breaking the parse.
- Model sections are also removed from `<custom-instructions>`; only the first regex match (if any) is injected via its `<model-…>` tag.
- Only the content under the first matching heading is injected.

<!-- Developers: See extractModelSection in src/node/utils/main/markdown.ts for the implementation. -->

Example:

```markdown
## Model: sonnet

Be terse and to the point.

## Model: openai:.\*codex

Use status reporting tools every few minutes.
```

## Practical layout

```
~/.mux/
  AGENTS.md          # Global instructions
  AGENTS.local.md    # Personal tweaks (gitignored)

my-project/
  AGENTS.md          # Project instructions (may include "Mode: Plan", etc.)
  AGENTS.local.md    # Personal tweaks (gitignored)
```
