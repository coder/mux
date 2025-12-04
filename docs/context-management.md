---
title: Context Management
description: Commands for managing conversation history and token usage
---

Commands for managing conversation history length and token usage.

## Comparison

| Approach                 | `/clear` | `/truncate` | `/compact`       | Start Here  |
| ------------------------ | -------- | ----------- | ---------------- | ----------- |
| **Speed**                | Instant  | Instant     | Slower (uses AI) | Instant     |
| **Context Preservation** | None     | Temporal    | Intelligent      | Intelligent |
| **Cost**                 | Free     | Free        | Uses API tokens  | Free        |
| **Reversible**           | No       | No          | No               | Yes         |

## Start Here

Start Here allows you to restart your conversation from a specific point, using that message as the entire conversation history. This is available on:

- **Plans** - Click "🎯 Start Here" on any plan to use it as your conversation starting point
- **Final Assistant messages** - Click "🎯 Start Here" on any completed assistant response

![Start Here](./img/plan-compact.webp)

This is a form of "opportunistic compaction" - the content is already well-structured, so the operation is instant. You can review the new starting point before the old context is permanently removed, making this the only reversible
compaction approach.

## `/clear` - Clear All History

Remove all messages from conversation history.

### Syntax

```
/clear
```

### Notes

- Instant deletion of all messages
- **Irreversible** - all history is permanently removed
- Use when you want to start a completely new conversation

---

## `/compact` - AI Summarization

Compress conversation history using AI summarization. Replaces the conversation with a compact summary that preserves context.

### Syntax

```
/compact [-t <tokens>] [-m <model>]
[continue message on subsequent lines]
```

### Options

- `-t <tokens>` - Maximum output tokens for the summary (default: ~2000 words)
- `-m <model>` - Model to use for compaction (sticky preference). Supports abbreviations like `haiku`, `sonnet`, or full model strings

### Examples

**Basic compaction:**

```
/compact
```

**Limit summary size:**

```
/compact -t 5000
```

**Choose compaction model:**

```
/compact -m haiku
```

Use Haiku for faster, lower-cost compaction. This becomes your default until changed.

**Auto-continue with custom message:**

```
/compact
Continue implementing the auth system
```

After compaction completes, automatically sends "Continue implementing the auth system" as a follow-up message.

**Multiline continue message:**

```
/compact
Now let's refactor the middleware to use the new auth context.
Make sure to add tests for the error cases.
```

Continue messages can span multiple lines for more detailed instructions.

**Combine all options:**

```
/compact -m haiku -t 8000
Keep working on the feature
```

Combine custom model, token limit, and auto-continue message.

### Notes

- Model preference persists globally across workspaces
- Uses the specified model (or workspace model by default) to summarize conversation history
- Preserves actionable context and specific details
- **Irreversible** - original messages are replaced
- Continue message is sent once after compaction completes (not persisted)

---

## `/truncate` - Simple Truncation

Remove a percentage of messages from conversation history (from the oldest first).

### Syntax

```
/truncate <percentage>
```

### Parameters

- `percentage` (required) - Percentage of messages to remove (0-100)

### Examples

```
/truncate 50
```

Remove oldest 50% of messages.

### Notes

- Simple deletion, no AI involved
- Removes messages from oldest to newest
- About as fast as `/clear`
- `/truncate 100` is equivalent to `/clear`
- **Irreversible** - messages are permanently removed

### OpenAI Responses API Limitation

<Warning>`/truncate` does not work with OpenAI models due to the Responses API architecture:</Warning>

- OpenAI's Responses API stores conversation state server-side
- Manual message deletion via `/truncate` doesn't affect the server-side state
- Instead, OpenAI models use **automatic truncation** (`truncation: "auto"`)
- When context exceeds the limit, the API automatically drops messages from the middle of the conversation

**Workarounds for OpenAI:**

- Use `/clear` to start a fresh conversation
- Use `/compact` to intelligently summarize and reduce context
- Rely on automatic truncation (enabled by default)
