# Workspaces

Workspaces in mux provide isolated development environments for parallel agent work. Each workspace maintains its own Git state, allowing you to explore different approaches, run multiple tasks simultaneously, or test changes without affecting your main repository.

## Workspace Types

mux supports three workspace backends:

- **[Worktree Workspaces](./worktree.md)**: Use [git worktrees](https://git-scm.com/docs/git-worktree) on your local machine. Worktrees share the `.git` directory with your main repository while maintaining independent working changes.
- **[Local (In-Place) Workspaces](./local-in-place.md)**: Reuse your existing project directory with no additional checkout. The agent operates on the branch and working tree you already have checked out.
- **[SSH Workspaces](./ssh.md)**: Regular git clones on a remote server accessed via SSH. These are completely independent repositories stored on the remote machine.

## Choosing a Backend

The workspace backend is selected when you create a workspace:

- **Worktree**: Best for fast iteration, local testing, and when you want an isolated checkout that still lives on your machine.
- **Local (in-place)**: Ideal for zero-copy workflows or when you need the agent to operate on your existing working tree without creating a new worktree.
- **SSH**: Ideal for heavy workloads, long-running tasks, or when you need access to remote infrastructure.

## Key Concepts

- **Isolation**: Each workspace has independent working changes and Git state
- **Branch flexibility**: Workspaces can switch branches, enter detached HEAD state, or create new branches as needed
- **Parallel execution**: Run multiple workspaces simultaneously on different tasks
- **Shared commits**: Worktree and local (in-place) workspaces share commits with the main repository immediately; SSH workspaces require pushing to sync

## Reviewing Code

Here are a few practical approaches to reviewing changes from workspaces, depending on how much you want your agent to interact with `git`:

- **Agent codes, commits, and pushes**: Ask agent to submit a PR and review changes in your git Web UI (GitHub, GitLab, etc.)
  - Also see: [Agentic Git Identity](./agentic-git-identity.md)
  - This is the preferred approach for `mux` development but requires additional care with repository security.
- **Agent codes and commits**: Review changes from the main repository via `git diff <workspace-branch>`, push changes when deemed acceptable.
- **Agent codes**: Enter worktree (click Terminal icon in workspace top bar), run `git add -p` and progressively accept changes into a commit.

## Reviewing Functionality

Some changes (especially UI ones) require the Human to determine acceptability. An effective approach for this is:

1. Ask agent to commit WIP when it's ready for Human review
2. Human, in main repository, checks out the workspace branch in a detached HEAD state: `git checkout --detach <workspace-branch>` (for worktree workspaces)

**Note**: For worktree workspaces, this workflow uses the detached HEAD state because the branch is already checked out in the workspace and you cannot check out the same branch multiple times across worktrees. For local (in-place) workspaces, the agent and human are literally sharing the same checkout—coordinate commits carefully.

If you want faster iteration in between commits, you can hop into the workspace directory and run a dev server (e.g. `bun dev`) there directly and observe the agent's work in real-time.

---

See the specific workspace type pages for detailed setup and usage instructions.
