# PRD: Context Reset via `/clear --soft`

## Summary

Add `/clear --soft` as a **Context Reset** operation: it starts a new active conversation context while preserving transcript history. Unlike `/clear`, it must not delete chat history. Unlike `/compact`, it must not summarize or send any reset marker to the LLM.

The visible transcript should show a **Context Reset Boundary** labeled `Context reset`, with earlier transcript history available through load-older history. Provider requests, token/context usage, and context-mutating actions should treat messages above the latest Context Boundary as outside the current active context.

## Background

Today, `/clear` destructively truncates chat history. Users sometimes want a fresh model context without losing the previous conversation for review, export, or audit. Compaction already creates durable boundaries that preserve older history while reducing active model context, but compaction carries a provider-visible summary. Context Reset needs similar boundary/window behavior without any provider-visible summary or synthetic note.

Domain terms are captured in `CONTEXT.md`. The architecture decision to model compaction and reset as kinds of **Context Boundary** is captured in `docs/adr/0002-context-boundaries-for-compaction-and-reset.md`.

## Goals

- Add `/clear --soft` to reset the active conversation context without deleting transcript history.
- Preserve `/clear` as the existing destructive **Hard Clear** behavior.
- Represent reset with a first-class **Context Reset Boundary**, not as fake compaction.
- Ensure prior messages and the reset boundary are provider-invisible after reset.
- Keep older transcript history reachable via load-older history.
- Keep context/token usage aligned with the new active context window.
- Expose Context Reset through the command palette as a distinct operation from Hard Clear.

## Non-goals

- Do not change `/clear` default behavior.
- Do not implement undo for Context Reset in v1.
- Do not broad-rename all existing compaction helpers in the first implementation.
- Do not treat Context Reset as a privacy or sharing boundary.
- Do not make the Context Reset Boundary a provider-visible system/user/assistant message.
- Do not implement full “resume from before reset” workflows in v1.

## User experience

### Slash command

- `/clear` remains destructive and deletes transcript history.
- `/clear --soft` performs a Context Reset.
- Unknown arguments or flags should continue to fail rather than silently falling back to hard clear.

### Command palette

Add a separate command palette action:

- **Reset Context, Preserve History**

Keep the existing hard-clear action distinct:

- **Clear History**

Recommended keywords for the new action: `context reset`, `soft clear`, `preserve history`, `reset chat`.

### Transcript display

After a non-empty Context Reset, the active transcript view should show a simple visible boundary row:

```text
──────── Context reset ────────
```

Older transcript history may be hidden behind the existing load-older history affordance. Loading older history should reveal messages above the boundary.

The command itself should not appear as a persisted user message. The boundary row is the transcript representation of the operation.

### Toasts and feedback

Recommended success copy:

- For reset with a boundary: `Context reset; history preserved`
- For no-op reset: `No context to reset`

Recommended failure cases:

- Active turn: `Cannot reset context while a turn is active. Press Esc to stop the stream first.`
- Queued/preparing input: `Cannot reset context while queued user input is pending. Send or clear the queued message first.`

## Functional requirements

### Command semantics

1. `/clear` remains a **Hard Clear** and deletes transcript history as today.
2. `/clear --soft` performs a **Context Reset**.
3. `/clear --soft` clears composer state like `/clear`; pending input, attachments, and reviews should not carry over.
4. `/clear --soft` is rejected while a turn is active.
5. `/clear --soft` is rejected while queued user input or a preparing turn is pending.
6. `/clear --soft` on an empty workspace is a no-op success and does not persist a boundary.
7. Repeated `/clear --soft` with no provider-eligible messages after the latest Context Boundary is a no-op success and does not append stacked boundaries.

### Boundary semantics

1. Introduce a first-class **Context Boundary** model with at least two kinds:
   - **Compaction Boundary**: carries provider-visible summary content.
   - **Context Reset Boundary**: provider-invisible separator that starts a new active context.
2. A Context Reset Boundary must be persisted with enough metadata for ordering, replay, pagination, and display.
3. A Context Reset Boundary should persist a timestamp, but the visible row should remain a simple `Context reset` label.
4. Context Reset Boundary must not be represented as fake compaction or a fake assistant summary.
5. Existing compaction histories must remain compatible.
6. The first implementation should add a narrow Context Boundary layer and avoid broad compaction-symbol renames unless locally necessary.

### Active context and provider requests

1. Provider request assembly must select messages from the latest Context Boundary / active context window.
2. Messages above the latest Context Boundary must not be sent to the provider.
3. A Context Reset Boundary itself must not be sent to the provider.
4. No synthetic text such as “context reset”, “history cleared”, “history compacted”, or similar should reach the model because of `/clear --soft`.
5. No-op detection should be based on provider-eligible messages since the latest Context Boundary, not merely persisted rows or visible rows.

### Agent carryover state

`/clear --soft` should match hard clear for model-affecting carryover state:

1. Clear file-change tracking.
2. Require goal re-engagement before goal continuation resumes.
3. Delete plan files consistently with current hard-clear behavior.
4. Do not delete transcript history.

### Transcript history, pagination, and export

1. Transcript history before a Context Reset Boundary remains persisted.
2. Older transcript history must be reachable in v1 through load-older history above the boundary.
3. Transcript export/share may include history above a Context Reset Boundary.
4. Context Reset is not a privacy boundary; users who need deletion should use hard `/clear`.
5. Partial or aborted messages before a reset remain preserved above the boundary.

### UI behavior above latest Context Boundary

1. Messages above the latest Context Boundary are viewable, copyable, and exportable.
2. Messages above the latest Context Boundary should not directly mutate the current active context in v1.
3. Disable or hide context-mutating actions above the latest Context Boundary, including direct retry/edit/start-here in the current active context.
4. Future explicit workflows may support forking or resuming from before a boundary, but that is out of scope for v1.

### Context usage

1. Token/context usage calculations should reflect **Active Conversation Context**.
2. After a Context Reset, usage should start after the latest Context Boundary and drop accordingly.
3. Loaded transcript history above a Context Reset Boundary must not inflate active context usage.

## Technical notes

### Existing behavior to preserve

Current hard clear flow:

- Frontend `/clear` calls `onTruncateHistory(1.0)`.
- Backend `WorkspaceService.truncateHistory()` rejects active turns, truncates history, emits delete events, deletes plan files on full clear, requires goal acknowledgment, and clears file state.
- It does not explicitly clear or reject queued messages today.

Do not change this behavior except where directly necessary for the new soft reset flow.

### Suggested implementation shape

- Add parser support for `/clear --soft` and represent parsed clear mode explicitly, e.g. `mode: "hard" | "soft"`.
- Add a backend workspace operation for Context Reset rather than encoding it as a magic truncate percentage.
- Add durable Context Boundary helpers that can recognize existing compaction boundaries and new reset boundaries.
- Update provider request slicing to use latest Context Boundary, then drop provider-invisible boundary rows before model conversion.
- Update UI aggregation/display to render a Context Reset Boundary row labeled `Context reset`.
- Update history pagination/load-more to treat Context Reset Boundary as a boundary window.
- Update token/context usage calculation to slice from latest Context Boundary.
- Update retry/edit/start-here eligibility to respect latest Context Boundary.

## Acceptance criteria

- `/clear` still destructively clears transcript history as before.
- `/clear --soft` preserves prior transcript history on disk.
- `/clear --soft` creates a visible `Context reset` boundary when there is provider-eligible context to reset.
- `/clear --soft` is a no-op success on empty current context windows and does not create stacked boundaries.
- After `/clear --soft`, provider requests include only post-boundary provider-eligible messages.
- Provider requests do not include the Context Reset Boundary or any synthetic reset/clear/compaction text.
- Older transcript history can be loaded above the Context Reset Boundary.
- Context/token usage reflects only the active post-boundary context.
- `/clear --soft` rejects active turns and queued/preparing user input.
- `/clear --soft` clears model-affecting carryover state consistently with hard clear.
- Command palette exposes Context Reset as a distinct action from Clear History.
- Context-mutating actions are disabled for messages above the latest Context Boundary.
- Existing compaction behavior and existing compacted histories continue to work.

## Test plan

### Unit tests

- Slash parser:
  - `/clear` parses as hard clear.
  - `/clear --soft` parses as soft clear.
  - Unknown flags/arguments fail.
- History/boundary helpers:
  - Existing compaction boundaries are recognized.
  - Context Reset Boundaries are recognized.
  - Latest Context Boundary selection works across mixed compaction/reset histories.
  - Empty/no-op reset does not append a boundary.
  - Repeated reset without provider-eligible messages does not append a boundary.
- Provider request assembly:
  - Pre-reset messages are excluded.
  - Context Reset Boundary is excluded.
  - Post-reset messages are included.
  - Compaction summary remains provider-visible for real compaction.
- Context usage:
  - Counts start after latest Context Boundary.
- Eligibility/actions:
  - Retry/edit/start-here are disabled above latest Context Boundary.

### Integration/UI tests

- Running `/clear --soft` renders a `Context reset` boundary.
- Older messages are reachable through load-older history.
- Transcript export includes loaded history and visible boundaries as expected.
- Command palette action triggers Context Reset.
- Active/queued/preparing rejection surfaces useful errors.

### Regression tests

- `/clear` still deletes transcript history.
- `/compact` still creates provider-visible compaction summaries.
- Existing histories with legacy compaction metadata still load and slice correctly.

## Dogfooding plan

Use a sandbox workspace with debug/provider request logging enabled.

1. Create a multi-turn chat with visible user and assistant messages.
2. Run `/clear --soft`.
3. Capture a screenshot and short video showing the `Context reset` boundary and fresh active area.
4. Verify `chat.jsonl` still contains pre-reset messages and a durable reset boundary.
5. Send a new post-reset message.
6. Inspect provider request/debug logs and confirm:
   - pre-reset messages are absent;
   - the reset boundary is absent;
   - no synthetic “context reset” or “history cleared” text is present;
   - the post-reset message is present.
7. Verify context/token usage drops after reset.
8. Use load-older history and capture screenshot/video showing pre-reset transcript history is reachable above the boundary.
9. Verify messages above the boundary are viewable/copyable/exportable but do not expose direct current-context retry/edit/start-here actions.
10. Run `/clear` hard in a separate sandbox workspace and verify destructive behavior remains unchanged.

## Open implementation decisions

These should be decided while coding unless they reveal product ambiguity:

- Exact metadata field names for Context Boundary kind.
- Whether hard `/clear` should later also reject queued/preparing input.
- Whether to add explicit `/clear --hard` as an alias.
- Exact command palette keywords and error toast strings.
