# Init Hooks

Add a `.mux/init` executable script to your project root to run commands when creating new workspaces.

## Example

```bash
#!/usr/bin/env bash
set -e

bun install
bun run build
```

Make it executable:

```bash
chmod +x .mux/init
```

## Behavior

- **Runs once** per workspace on creation
- **Streams output** to the workspace UI in real-time
- **Non-blocking** - workspace is immediately usable, even while hook runs
- **Exit codes preserved** - failures are logged but don't prevent workspace usage

The init script runs in the workspace directory with the workspace's environment.

## Environment Variables

Init hooks receive the following environment variables:

- `MUX_PROJECT_PATH` - Absolute path to the project root on the **local machine**
  - Always refers to your local project path, even on SSH workspaces
  - Useful for logging, debugging, or runtime-specific logic
- `MUX_RUNTIME` - Runtime type: `"worktree"`, `"local"`, or `"ssh"`
  - Use this to detect whether the hook is running in a worktree, directly in your project directory, or on a remote machine

**Note for SSH workspaces:** Since the project is synced to the remote machine, files exist in both locations. The init hook runs in the workspace directory (`$PWD`), so use relative paths to reference project files:

```bash
#!/usr/bin/env bash
set -e

echo "Runtime: $MUX_RUNTIME"
echo "Local project path: $MUX_PROJECT_PATH"
echo "Workspace directory: $PWD"

# Copy .env from project root (works for both local and SSH)
# The hook runs with cwd = workspace, and project root is the parent directory
if [ -f "../.env" ]; then
  cp "../.env" "$PWD/.env"
fi

# Runtime-specific behavior
case "$MUX_RUNTIME" in
  worktree)
    echo "Running in local worktree"
    ;;
  local)
    echo "Running directly in project directory"
    ;;
  ssh)
    echo "Running on SSH remote"
    ;;
esac

bun install
```

## Use Cases

- Install dependencies (`npm install`, `bun install`, etc.)
- Run build steps
- Generate code or configs
- Set up databases or services
- Warm caches

## Output

Init output appears in a banner at the top of the workspace. Click to expand/collapse the log. The banner shows:

- Script path (`.mux/init`)
- Status (running, success, or exit code on failure)
- Full stdout/stderr output

## Idempotency

The hook runs every time you create a workspace, even if you delete and recreate with the same name. Make your script idempotent if you're modifying shared state.
