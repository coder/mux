# Local (In-Place) Workspaces

Local (in-place) workspaces operate directly inside your project directory. Unlike [worktree workspaces](./worktree.md), they do **not** create a separate checkout. The agent works with the branch, index, and working tree that you already have checked out.

## When to Use

- You want zero-copy workflows (benchmarks, quick experiments, or short-lived agents)
- You need the agent to see files that are too large to duplicate efficiently
- You plan to drive the session from another terminal that is already inside the project directory

## Key Behavior

- **Single workspace per project**: mux enforces one in-place workspace per project to avoid conflicting agent sessions.
- **Current branch only**: the agent starts on whatever branch is currently checked out in your repository. Branch switches affect your main working tree immediately.
- **Shared Git state**: any uncommitted changes are visible to both you and the agent. The agent can stage, commit, and push directly from your checkout.
- **No automatic cleanup**: deleting the workspace inside mux only removes it from the workspace list—your project directory remains untouched.
- **Init hooks**: `.mux/init` still runs in the project directory. Use `MUX_RUNTIME=local` to special-case logic if needed.

## Recommended Safeguards

- Commit or stash important work before starting an in-place session.
- Consider creating a temporary branch manually before opening the workspace if you want to isolate commits.
- Use descriptive workspace names so it is clear what the agent is attempting.
- Review the agent's Git operations carefully—there is no isolation layer to fall back on.

## Switching Between Modes

You can select **Local (in-place)** from the workspace creation dialog or via the `/new` command (`/new -r local`). Switch back to **Worktree** or **SSH** at any time for isolated workspaces.
