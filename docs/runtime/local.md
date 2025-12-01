# Local Runtime

Local runtime runs the agent directly in your project directory—the same directory you use for development. There's no worktree isolation; the agent works in your actual working copy.

## When to Use

- Quick one-off tasks in your current working copy
- Reviewing agent work alongside your own uncommitted changes
- Projects where worktrees don't work well (e.g., some monorepos)

## Caveats

⚠️ **No isolation**: Multiple local workspaces for the same project see and modify the same files. Running them simultaneously can cause conflicts. mux shows a warning when another local workspace is actively streaming.

⚠️ **Affects your working copy**: Agent changes happen in your actual project directory.

## Filesystem

The workspace path is your project directory itself. No additional directories are created.
