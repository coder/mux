# Mux Conversation Context

Mux preserves workspace transcripts while controlling which messages are active conversation context for the agent.

## Language

**Context Reset**:
Starts a new active conversation context while preserving earlier transcript history.
_Avoid_: soft clear, compaction, truncate, clear history

**Transcript History**:
The persisted record of messages in a workspace, including messages that are no longer active context.
_Avoid_: context, prompt history

**Active Conversation Context**:
The subset of transcript history eligible to be sent to the agent for the next response.
_Avoid_: chat history, transcript

**Compaction Boundary**:
A context boundary that carries a provider-visible summary of earlier transcript history.
_Avoid_: context reset

**Context Reset Boundary**:
A visible separator in transcript history where the active conversation context starts over; older history may be hidden behind a load-older affordance.
_Avoid_: compaction boundary, summary message

**Agent Carryover State**:
Workspace state outside transcript history that can influence future agent turns.
_Avoid_: hidden context, leftovers

**Context Boundary**:
A transcript marker that divides provider-eligible context windows without deleting transcript history.
_Avoid_: synthetic assistant message, compacted message

**Hard Clear**:
A destructive operation that deletes transcript history for the active workspace.
_Avoid_: context reset, soft clear

**Provider-Eligible Message**:
A transcript message that can contribute content to a future agent request.
_Avoid_: persisted row, visible message

**Transcript Export**:
A shared or copied representation of transcript history, including visible context boundaries.
_Avoid_: active context export

## Relationships

- A **Hard Clear** deletes **Transcript History**.
- A **Context Reset** preserves **Transcript History**.
- A **Context Reset** creates a **Context Reset Boundary**.
- A **Compaction Boundary** is a kind of **Context Boundary**.
- A **Context Reset Boundary** is a kind of **Context Boundary**.
- A **Context Reset Boundary** separates older **Transcript History** from the new **Active Conversation Context**.
- Older **Transcript History** above a **Context Reset Boundary** can be hidden behind load-older history.
- **Active Conversation Context** may be smaller than **Transcript History**.

- A **Context Reset** clears **Agent Carryover State** so previous work does not influence future agent turns.
- A **Context Reset Boundary** is created only when the current context window contains at least one **Provider-Eligible Message**.
- A **Context Reset Boundary** is visible transcript structure, not conversation content for the agent.

- Context usage reflects **Active Conversation Context**, not all loaded **Transcript History**.
- Messages above the latest **Context Boundary** are viewable and exportable but cannot directly mutate the current **Active Conversation Context**.
- A **Transcript Export** can include **Transcript History** from above a **Context Reset Boundary**.

## Example dialogue

> **Dev:** "After a **Context Reset**, can the agent answer from messages above the **Context Reset Boundary**, or see a hidden note that the reset happened?"
> **Domain expert:** "No — those messages remain in **Transcript History**, and the boundary is visible transcript structure, but neither is part of the agent's **Active Conversation Context**."

> **Dev:** "Are **Compaction Boundaries** and **Context Reset Boundaries** separate mechanisms?"
> **Domain expert:** "No — both are **Context Boundaries**. A **Compaction Boundary** summarizes earlier history for the agent; a **Context Reset Boundary** does not."

> **Dev:** "Should `/clear` preserve **Transcript History** now that **Context Reset** exists?"
> **Domain expert:** "No — `/clear` remains a **Hard Clear**. `/clear --soft` performs a **Context Reset**."

> **Dev:** "If there is no **Transcript History**, should a **Context Reset** create a boundary anyway?"
> **Domain expert:** "No — without earlier history, there is nothing for a **Context Reset Boundary** to separate."

> **Dev:** "If the user repeats `/clear --soft` before sending another message, should we append another **Context Reset Boundary**?"
> **Domain expert:** "No — repeated resets with no active-context messages are no-op successes."

> **Dev:** "Should the `/clear --soft` command itself appear as a user message?"
> **Domain expert:** "No — a **Context Reset** is represented by a **Context Reset Boundary**, not by a user prompt."

> **Dev:** "Can a **Context Reset** happen while the agent is still responding?"
> **Domain expert:** "No — context can only be reset once the active turn has stopped and transcript ordering is stable."

> **Dev:** "How should users find **Context Reset** outside slash commands?"
> **Domain expert:** "Expose it as a separate command from **Hard Clear**, named around resetting context while preserving history."

> **Dev:** "What should the visible separator say?"
> **Domain expert:** "Use `Context reset`; avoid labels that imply transcript history was deleted."

> **Dev:** "Should a **Context Reset Boundary** show when it happened?"
> **Domain expert:** "Persist the timestamp for ordering and audit, but keep the visible separator label simple."

> **Dev:** "Can a **Context Reset** happen while user input is queued?"
> **Domain expert:** "No — queued input belongs to the old context and must be sent or cleared before resetting."

> **Dev:** "What happens to pending composer content when a user performs a **Context Reset**?"
> **Domain expert:** "Resetting context starts fresh, so pending composer state should not carry over."

> **Dev:** "Should partial or aborted messages before a **Context Reset Boundary** be cleaned up?"
> **Domain expert:** "No — they remain **Transcript History** above the boundary, but are outside the new **Active Conversation Context**."

## Flagged ambiguities

- "soft clear" is a user-facing command style, not the domain concept; resolved: use **Context Reset** for the behavior.
- "compaction boundary" implies summarization; resolved: use **Context Reset Boundary** for a reset without summarization.
