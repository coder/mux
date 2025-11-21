# Workspace Scripts

Execute custom scripts from your workspace using slash commands or let the AI Agent run them as tools.

## Overview

Scripts are stored in `.cmux/scripts/` within each workspace. They serve two purposes:

1. **Human Use**: Executable via `/script <name>` or `/s <name>` in chat.
2. **Agent Use**: Automatically exposed to the AI as tools (`script_<name>`), allowing the agent to run complex workflows you define.

Scripts run in the workspace directory with full access to project secrets and environment variables.

**Key Point**: Scripts are workspace-specific. Each workspace has its own custom toolkit defined in `.cmux/scripts/`.

## Creating Scripts

1. **Create the scripts directory**:

   ```bash
   mkdir -p .cmux/scripts
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
   chmod +x .cmux/scripts/deploy
   ```

## Agent Integration (AI Tools)

Every executable script in `.cmux/scripts/` is automatically registered as a tool for the AI Agent.

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
3. **Feedback**: Use `MUX_PROMPT` to guide the AI on what to do next if the script succeeds or fails (see below).

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

### Environment Variables

Scripts receive special environment variables for controlling cmux behavior and interacting with the agent:

#### `MUX_OUTPUT` (User Toasts)

Path to a temporary file for custom toast display content. Write markdown here for rich formatting in the UI toast:

```bash
#!/usr/bin/env bash
# Description: Deploy with custom output

echo "Deploying..." # Logged to stdout

# Write formatted output for toast display
cat >> "$MUX_OUTPUT" << 'EOF'
## 🚀 Deployment Complete

✅ Successfully deployed to staging
EOF
```

#### `MUX_PROMPT` (Agent Feedback)

Path to a temporary file for **sending messages back to the agent**. This is powerful for "Human-in-the-loop" or "Chain-of-thought" workflows where a script performs an action and then asks the agent to analyze the result.

```bash
#!/usr/bin/env bash
# Description: Run tests and ask Agent to fix failures

if ! npm test > test.log 2>&1; then
  echo "❌ Tests failed" >> "$MUX_OUTPUT"

  # Feed the failure log back to the agent automatically
  cat >> "$MUX_PROMPT" << EOF
The test suite failed. Here is the log:

\`\`\`
$(cat test.log)
\`\`\`

Please analyze this error and propose a fix.
EOF
fi
```

**Result**:

1. Script fails.
2. Agent receives the tool output (stderr/stdout) **PLUS** the content of `MUX_PROMPT` as part of the tool result.
3. Agent can immediately act on the instructions in `MUX_PROMPT`.

**Note**: If a human ran the script, the content of `MUX_PROMPT` is sent as a **new user message** to the agent, triggering a conversation.

### File Size Limits

- **MUX_OUTPUT**: Maximum 10KB (truncated if exceeded)
- **MUX_PROMPT**: Maximum 100KB (truncated if exceeded)

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

- Scripts are discovered automatically from `.cmux/scripts/` in the current workspace.
- Discovery is cached for performance but refreshes intelligently.
- **Sanitization**: Script names are sanitized for tool use (e.g., `my-script.sh` -> `script_my_script_sh`).

## Troubleshooting

**Script not appearing in suggestions or tools?**

- Ensure file is executable: `chmod +x .cmux/scripts/scriptname`
- Verify file is in `.cmux/scripts/` directory.
- Check for valid description header.

**Agent using script incorrectly?**

- Improve the `# Description:` header. Explicitly tell the agent what arguments to pass.
