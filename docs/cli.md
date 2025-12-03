# Command Line Interface

Mux provides a CLI for running agent sessions without opening the desktop app.

## `mux run`

Run an agent session in any directory:

```bash
# Basic usage - run in current directory
mux run "Fix the failing tests"

# Specify a directory
mux run --dir /path/to/project "Add authentication"

# Use SSH runtime
mux run --runtime "ssh user@myserver" "Deploy changes"

# Plan mode (proposes a plan, then auto-executes)
mux run --mode plan "Refactor the auth module"

# Pipe instructions via stdin
echo "Add logging to all API endpoints" | mux run

# JSON output for scripts
mux run --json "List all TypeScript files" | jq '.type'
```

### Options

| Option                 | Short | Description                                        | Default           |
| ---------------------- | ----- | -------------------------------------------------- | ----------------- |
| `--dir <path>`         | `-d`  | Project directory                                  | Current directory |
| `--model <model>`      | `-m`  | Model to use (e.g., `anthropic:claude-sonnet-4-5`) | Default model     |
| `--runtime <runtime>`  | `-r`  | Runtime: `local`, `worktree`, or `ssh <host>`      | `local`           |
| `--mode <mode>`        |       | Agent mode: `plan` or `exec`                       | `exec`            |
| `--thinking <level>`   | `-t`  | Thinking level: `off`, `low`, `medium`, `high`     | `medium`          |
| `--timeout <duration>` |       | Timeout (e.g., `5m`, `300s`, `300000`)             | No timeout        |
| `--json`               |       | Output NDJSON for programmatic use                 | Off               |
| `--quiet`              | `-q`  | Only output final result                           | Off               |
| `--workspace-id <id>`  |       | Explicit workspace ID                              | Auto-generated    |
| `--config-root <path>` |       | Mux config directory                               | `~/.mux`          |

### Runtimes

- **`local`** (default): Runs directly in the specified directory. Best for one-off tasks.
- **`worktree`**: Creates an isolated git worktree under `~/.mux/src`. Useful for parallel work.
- **`ssh <host>`**: Runs on a remote machine via SSH. Example: `--runtime "ssh user@myserver.com"`

### Output Modes

- **Default (TTY)**: Human-readable streaming with tool call formatting
- **`--json`**: NDJSON streaming - each line is a JSON object with event data
- **`--quiet`**: Suppresses streaming output, only shows final assistant response

### Examples

```bash
# Quick fix in current directory
mux run "Fix the TypeScript errors"

# Use a specific model with extended thinking
mux run -m anthropic:claude-sonnet-4-5 -t high "Optimize database queries"

# Run on remote server
mux run -r "ssh dev@staging.example.com" -d /app "Update dependencies"

# Scripted usage with timeout
mux run --json --timeout 5m "Generate API documentation" > output.jsonl

# Plan first, then execute
mux run --mode plan "Migrate from REST to GraphQL"
```

## `mux server`

Start the HTTP/WebSocket server for remote access (e.g., from mobile devices):

```bash
mux server --port 3000 --host 0.0.0.0
```

Options:

- `--host <host>` - Host to bind to (default: `localhost`)
- `--port <port>` - Port to bind to (default: `3000`)
- `--auth-token <token>` - Optional bearer token for authentication
- `--add-project <path>` - Add and open project at the specified path

## `mux version`

Print the version and git commit:

```bash
mux version
# mux v0.8.4 (abc123)
```
