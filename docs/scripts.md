# Workspace Scripts

Execute custom scripts from your workspace using slash commands or let the AI Agent run them as tools.

## Overview

Scripts are stored in `.mux/scripts/` within each workspace. They serve two purposes:

1. **Human Use**: Executable via `/script <name>` or `/s <name>` in chat.
2. **Agent Use**: Automatically exposed to the AI as tools (`script_<name>`), allowing the agent to run complex workflows you define.

Scripts run in the workspace directory with full access to project secrets and environment variables.

**Key Point**: Scripts are workspace-specific. Each workspace has its own custom toolkit defined in `.mux/scripts/`.

## Creating Scripts

1. **Create the scripts directory**:

   ```bash
   mkdir -p .mux/scripts
   ```

2. **Add an executable script**:

   ```bash
   #!/usr/bin/env bash
   # Description: Deploy to staging. Accepts one optional argument: 'dry-run' to simulate.

   if [ "${1:-}" == "dry-run" ]; then
     echo "Simulating deployment..."
   else
     echo "Deploying to staging..."
   fi
   ```

   **Crucial**: The `# Description:` line is what the AI reads to understand the tool. Be descriptive about what the script does and what arguments it accepts.

3. **Make it executable**:

   ```bash
   chmod +x .mux/scripts/deploy
   ```

## Agent Integration (AI Tools)

Every executable script in `.mux/scripts/` is automatically registered as a tool for the AI Agent.

- **Tool Name**: `script_<name>` (e.g., `deploy` -> `script_deploy`, `run-tests` -> `script_run_tests`)
- **Tool Description**: Taken from the script's header comment (`# Description: ...`).
- **Arguments**: The AI can pass an array of string arguments to the script.

### Optimization for AI

To make your scripts effective AI tools:

1. **Clear Descriptions**: Explicitly state what the script does and what arguments it expects.

   ```bash
   # Description: Fetch logs. Requires one argument: the environment name (dev|prod).
   ```

2. **Robustness**: Use `set -euo pipefail` to ensure the script fails loudly if something goes wrong, allowing the AI to catch the error.
3. **Clear Output**: Write structured output to stdout so the agent can understand results and take action.

## Usage

### Basic Execution

Type `/s` or `/script` in chat to see available scripts with auto-completion:

```
/s deploy
```

### With Arguments

Pass arguments to scripts:

```
/s deploy --dry-run
/script test --verbose --coverage
```

Arguments are passed directly to the script as `$1`, `$2`, etc.

## Execution Context

Scripts run with:

- **Working directory**: The workspace directory.
- **Environment**: Full workspace environment + project secrets + special cmux variables.
- **Timeout**: 5 minutes by default.
- **Streams**: stdout/stderr are captured.
  - **Human**: Visible in the chat card.
  - **Agent**: Returned as the tool execution result.

### Standard Streams

Scripts follow Unix conventions for output:

- **stdout**: Sent to the agent as the tool result. Use this for structured output the agent should act on.
- **stderr**: Shown to the user in the UI but **not** sent to the agent. Use this for progress messages, logs, or debugging info that doesn't need AI attention.

This design means scripts work identically whether run inside mux or directly from the command line.

#### Example: Test Runner

```bash
#!/usr/bin/env bash
# Description: Run tests and report failures for the agent to fix

set -euo pipefail

# Progress to stderr (user sees it, agent doesn't)
echo "Running test suite..." >&2

if npm test > test.log 2>&1; then
  # Success message to stdout (agent sees it)
  echo "✅ All tests passed"
else
  # Structured failure info to stdout (agent sees and can act on it)
  cat << EOF
❌ Tests failed. Here is the log:

\`\`\`
$(cat test.log)
\`\`\`

Please analyze this error and propose a fix.
EOF
  exit 1
fi
```

**Result**:

1. User sees "Running test suite..." progress message.
2. On failure, agent receives the structured error with test log and instructions.
3. Agent can immediately analyze and propose fixes.

## Example Scripts

### Deployment Script

```bash
#!/usr/bin/env bash
# Description: Deploy application. Accepts one arg: environment (default: staging).
set -euo pipefail

ENV=${1:-staging}
echo "Deploying to $ENV..."
# ... deployment logic ...
echo "Deployment complete!"
```

### Web Fetch Utility

```bash
#!/usr/bin/env bash
# Description: Fetch a URL. Accepts exactly one argument: the URL.
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <url>"
    exit 1
fi
curl -sL "$1"
```

## Script Discovery

- Scripts are discovered automatically from `.mux/scripts/` in the current workspace.
- Discovery is cached for performance but refreshes intelligently.
- **Sanitization**: Script names are sanitized for tool use (e.g., `my-script.sh` -> `script_my_script_sh`).

## Troubleshooting

**Script not appearing in suggestions or tools?**

- Ensure file is executable: `chmod +x .mux/scripts/scriptname`
- Verify file is in `.mux/scripts/` directory.
- Check for valid description header.

**Agent using script incorrectly?**

- Improve the `# Description:` header. Explicitly tell the agent what arguments to pass.
