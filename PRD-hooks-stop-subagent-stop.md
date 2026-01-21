# PRD: Stop and SubagentStop Hooks

## Status
Ready for implementation

## Summary
Add `Stop` and `SubagentStop` hooks that run when the agent (or subagent) is about to stop. These hooks can force the agent to continue working by returning a reason.

**Scope**: Stop and SubagentStop hooks only. Other hooks (PreToolUse, PostToolUse, Notification, etc.) are out of scope for this PRD.

## Problem Statement
Users cannot:
- Ensure the agent completes all tasks before stopping (e.g., "run tests before stopping")
- Implement custom completion criteria (e.g., "verify no lint errors")
- Prevent premature stops when multi-step workflows are incomplete

Claude Code's Stop hook enables agentic workflows where the agent keeps working until certain conditions are met.

## Claude Code Compatibility
This follows the Claude Code hooks specification exactly:
- Same `settings.json` location and format
- Same stdin JSON input schema
- Same exit code semantics
- Same JSON output format (`decision`, `reason`, `continue`, etc.)

Reference: https://code.claude.com/docs/en/hooks

## Current State
Mux has no hook that runs when the agent stops. The agent decides when to stop based on its own judgment.

---

## Specification

### Configuration

**Locations** (in priority order, later overrides earlier):
```
~/.mux/settings.json           # User settings (global)
.mux/settings.json             # Project settings
.mux/settings.local.json       # Local (gitignored)
```

**Format** (same as UserPromptSubmit):
```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$MUX_PROJECT_DIR/.mux/hooks/stop-check.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/subagent-stop-hook.py"
          }
        ]
      }
    ]
  }
}
```

### When They Run
- **Stop**: After the main agent generates a final response (no more tool calls). Does NOT run on user interrupt.
- **SubagentStop**: After a subagent (Task tool) completes its response, before returning control to the main agent.

### Hook Input (via stdin)

```json
{
  "session_id": "workspace-abc123",
  "transcript_path": "/home/user/.mux/sessions/workspace-abc123/chat.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `session_id` | string | Workspace ID |
| `transcript_path` | string | Path to chat history file (for analysis) |
| `cwd` | string | Project working directory |
| `permission_mode` | string | Current permission mode |
| `hook_event_name` | string | `"Stop"` or `"SubagentStop"` |
| `stop_hook_active` | boolean | `true` if agent is already continuing from a stop hook (for loop prevention) |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `MUX_PROJECT_DIR` | Absolute path to project root |
| `CLAUDE_PROJECT_DIR` | Alias for Claude Code compatibility |

### Hook Output

#### Exit Codes

| Exit Code | Behavior |
|-----------|----------|
| `0` | Success. stdout parsed as JSON for control |
| `2` | Blocking error. stderr shown to agent, forces continuation |
| Other | Non-blocking warning. stderr logged, agent stops normally |

#### JSON Output (Exit Code 0)

```json
{
  "decision": "block",
  "reason": "Task incomplete. Please run tests before stopping."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `decision` | `"block"` \| undefined | If `"block"`, agent continues working |
| `reason` | string | **Required when blocking**. Shown to agent as guidance |
| `continue` | boolean | If false, takes precedence over `decision: "block"` |
| `stopReason` | string | Shown when continue is false |
| `suppressOutput` | boolean | Hide output from transcript (default: false) |

**Note**: `continue: false` takes precedence over `decision: "block"`. Both can prevent stopping, but `continue: false` is a general stop mechanism.

#### Exit Code 2 (Blocking Error)

stderr is shown to the agent as the reason to continue:

```bash
#!/bin/bash
echo "Error: Tests not run. Please run make test before stopping" >&2
exit 2
```

The agent sees:
```
[Stop hook requested continuation]
Error: Tests not run. Please run make test before stopping
```

### Forcing Agent to Continue
Exit code 2 with a reason in stderr makes the agent continue:

```bash
#!/usr/bin/env bash
# .mux/stop

# Don't stop if tests haven't been run
if [[ "$MUX_STOP_HOOK_ACTIVE" == "true" ]]; then
  # Already continuing from a stop hook - don't loop
  exit 0
fi

# Check if tests were run in this session
if ! grep -q '"tool_name":"bash".*"script":".*test' "$MUX_TRANSCRIPT_PATH" 2>/dev/null; then
  echo "Please run tests before stopping" >&2
  exit 2
fi

exit 0
```

The agent sees:
```
[Stop hook requested continuation]
Please run tests before stopping
```

### Loop Prevention
`MUX_STOP_HOOK_ACTIVE` is set to `"true"` when the agent is already continuing from a stop hook. Hooks should check this to prevent infinite loops:

```bash
if [[ "$MUX_STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0  # Don't block again
fi
```

---

## Implementation

### Phase 1: Types and Executor

**Extend** `src/node/services/hooks/types.ts`:

```typescript
/**
 * Input passed to Stop/SubagentStop hooks via stdin (JSON)
 */
export interface StopHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: string;
  hook_event_name: "Stop" | "SubagentStop";
  stop_hook_active: boolean;
}

/**
 * Result from running Stop/SubagentStop hooks
 */
export interface StopHooksResult {
  /** Whether the agent should stop */
  shouldStop: boolean;
  /** Reason to continue (shown to agent when shouldStop: false) */
  continueReason?: string;
  /** Any warnings from hooks */
  warnings?: string[];
}
```

**Extend** `src/node/services/hooks/settingsLoader.ts`:
- Add `Stop?: HookConfig[]` and `SubagentStop?: HookConfig[]` to settings schema

**New file**: `src/node/services/hooks/stopHookExecutor.ts`:
```typescript
/**
 * Execute Stop/SubagentStop hooks.
 * Returns whether agent should stop and any continuation reason.
 */
export async function runStopHooks(
  runtime: Runtime,
  projectDir: string,
  input: StopHookInput,
  options?: { abortSignal?: AbortSignal }
): Promise<StopHooksResult>
```

### Phase 2: Integration into AgentSession

**Location**: `src/node/services/agentSession.ts`

**Integration point**: The `forward("stream-end")` handler around line 1102.

Currently:
```typescript
forward("stream-end", async (payload) => {
  this.activeCompactionRequest = undefined;
  const handled = await this.compactionHandler.handleCompletion(payload as StreamEndEvent);
  if (!handled) {
    this.emitChatEvent(payload);
  }
  this.sendQueuedMessages();
});
```

After:
```typescript
forward("stream-end", async (payload) => {
  this.activeCompactionRequest = undefined;
  const handled = await this.compactionHandler.handleCompletion(payload as StreamEndEvent);
  if (!handled) {
    this.emitChatEvent(payload);
  }

  // Run Stop hook if not interrupted by user
  if (!payload.interrupted) {
    const stopResult = await this.runStopHooks(payload.stopHookActive ?? false);
    if (!stopResult.shouldStop && stopResult.continueReason) {
      // Queue a system message to make agent continue
      const continueMessage = `[Stop hook requested continuation]\n${stopResult.continueReason}`;
      this.queueMessage(continueMessage, {
        ...options,
        muxMetadata: { stopHookActive: true },  // Prevent infinite loops
      });
    }
  }

  this.sendQueuedMessages();
});
```

**New method** on AgentSession:
```typescript
private async runStopHooks(
  stopHookActive: boolean
): Promise<StopHooksResult>
```

### Phase 3: Integration into Task Tool

**Location**: `src/node/services/tools/task.ts`

**Integration point**: Before `taskService.waitForAgentReport()` returns (line 96).

```typescript
// After task completes, run SubagentStop hooks
const subagentStopResult = await runSubagentStopHooks(runtime, projectDir, {
  session_id: created.data.taskId,
  transcript_path: taskTranscriptPath,
  cwd: projectDir,
  permission_mode: "default",
  hook_event_name: "SubagentStop",
  stop_hook_active: false,
});

if (!subagentStopResult.shouldStop && subagentStopResult.continueReason) {
  // Continue the subagent with the hook's reason
  await taskService.sendMessage(created.data.taskId, subagentStopResult.continueReason, {
    muxMetadata: { stopHookActive: true },
  });
  // Wait for completion again (with max iterations check)
}
```

### Phase 4: State Tracking

Add `stopHookActive` tracking to prevent infinite loops:

1. **In StreamEndEvent**: Add `stopHookActive?: boolean` field
2. **In SendMessageOptions**: Add to `muxMetadata` for tracking across messages
3. **In StopHookInput**: Pass current state to hook for its own loop prevention

### File Structure

```
src/node/services/hooks/
  index.ts                  # Add Stop/SubagentStop exports
  types.ts                  # Add StopHookInput, StopHooksResult
  settingsLoader.ts         # Add Stop/SubagentStop to schema
  hookExecutor.ts           # Existing (for UserPromptSubmit)
  stopHookExecutor.ts       # NEW: Stop/SubagentStop execution

src/node/services/
  agentSession.ts           # Integration point (stream-end handler)

src/node/services/tools/
  task.ts                   # SubagentStop integration
```

## Use Cases

1. **Test Verification**
   ```bash
   # .mux/stop
   if ! grep -q 'test.*pass' "$MUX_TRANSCRIPT_PATH"; then
     echo "Run and verify tests pass before stopping" >&2
     exit 2
   fi
   ```

2. **Lint Check**
   ```bash
   # .mux/stop
   if make lint 2>&1 | grep -q 'error'; then
     echo "Fix lint errors before stopping" >&2
     exit 2
   fi
   ```

3. **Commit Reminder**
   ```bash
   # .mux/stop
   if [[ -n "$(git status --porcelain)" ]]; then
     echo "You have uncommitted changes. Please commit or stash." >&2
     exit 2
   fi
   ```

4. **Subagent Completion Check**
   ```bash
   # .mux/subagent_stop
   # Ensure subagent actually did something
   if ! grep -q 'tool_name' "$MUX_TRANSCRIPT_PATH"; then
     echo "Subagent should use tools to complete the task" >&2
     exit 2
   fi
   ```

---

## Testing

### Unit Tests

**stopHookExecutor.test.ts**:
- Exit 0 (no JSON) → shouldStop: true
- Exit 0 + `decision: "block"` with reason → shouldStop: false, continueReason set
- Exit 0 + `continue: false` → shouldStop: true (takes precedence)
- Exit 2 → shouldStop: false, stderr as continueReason
- Exit 1 → shouldStop: true, warning logged
- Timeout → shouldStop: true, warning logged
- Invalid JSON → treated as plain text, shouldStop: true

**settingsLoader.test.ts**:
- Load Stop hooks from settings
- Load SubagentStop hooks from settings
- Merge user + project + local settings

### Integration Tests

**agentSession.stop.test.ts**:
- Agent stops when no hook configured
- Agent stops when hook exits 0
- Agent continues when hook exits 2 (with correct message)
- Agent continues when hook returns `decision: "block"`
- Loop prevention: stopHookActive passed correctly
- Max continuation limit (3) prevents infinite loops
- User interrupt bypasses stop hook

## Safety Mechanisms

1. **Loop Prevention**: `MUX_STOP_HOOK_ACTIVE` flag
2. **Max Continuations**: Limit to 3 stop-hook-triggered continuations per turn
3. **Timeout**: 10 second hook timeout
4. **User Override**: Escape key always stops, even with stop hook

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Infinite loops | `MUX_STOP_HOOK_ACTIVE` flag, max continuations |
| Agent runs forever | User can always interrupt with Escape |
| Expensive hook (runs tests) | Timeout + async execution |
| Hook errors cause hangs | Timeout + fallback to normal stop |

## Success Criteria

1. Stop hook can make agent continue working
2. SubagentStop hook can make subagent continue
3. Loop prevention works (no infinite continuation)
4. User can always interrupt regardless of hooks
5. Works on both local and SSH workspaces
