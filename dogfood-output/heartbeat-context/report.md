# Dogfood Report: Heartbeat context modes

| Field | Value |
|-------|-------|
| **Date** | 2026-04-03 |
| **App URL** | http://127.0.0.1:44511/workspace/c840c60e15 |
| **Session** | heartbeat-context |
| **Scope** | Verify heartbeat modal rendering plus compact/reset heartbeat execution in a dev-server sandbox |

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| **Total** | **0** |

Validated successfully:

- Heartbeat modal renders the new context dropdown with all three options.
- `compact` mode performs a real idle compaction before the heartbeat follow-up.
- `reset` mode appends a visible synthetic reset boundary before the heartbeat follow-up.
- On-disk `chat.jsonl` retained older history while provider-facing context advanced from the newest durable boundary.

## Evidence

### Modal

- `screenshots/heartbeat-modal.png`
- `screenshots/compact-config-from-persisted-state.png`
- `screenshots/reset-config-from-persisted-state.png`

### Compact flow

- `screenshots/compact-flow-transcript-clean.png`
- `videos/compact-flow.webm`

Observed transcript shape:

1. durable compaction boundary
2. heartbeat user message
3. heartbeat assistant response

### Reset flow

- `screenshots/reset-flow-transcript-clean.png`
- `videos/reset-flow.webm`

Observed transcript shape:

1. visible synthetic reset boundary
2. heartbeat user message
3. heartbeat assistant response

## Notes

- Browser automation verified modal rendering and persisted-state display.
- Runtime verification of compact/reset execution was confirmed from both the rendered transcript and the sandbox session's `chat.jsonl` history.
- A direct ORPC call was used to seed persisted heartbeat settings for browser-mode verification because the modal save interaction was not reliably reproducible under agent-browser automation in this sandbox.
