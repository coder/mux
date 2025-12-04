---
title: Workspaces
description: Isolated development environments for parallel agent work
---

Workspaces in mux provide isolated development environments for parallel agent work. Each workspace maintains its own Git state, allowing you to explore different approaches, run multiple tasks simultaneously, or test changes without affecting your main repository.

## Runtimes

mux supports three [runtime types](/runtime):

- **[Local](/runtime/local)**: Run directly in your project directory. No isolation—best for quick edits to your working copy.

- **[Worktree](/runtime/worktree)**: Isolated directories using [git worktrees](https://git-scm.com/docs/git-worktree). Worktrees share `.git` with your main repository while maintaining independent working changes.

- **[SSH](/runtime/ssh)**: Remote execution over SSH. Ideal for heavy workloads, security isolation, or leveraging remote infrastructure.

## Choosing a Runtime

The runtime is selected when you create a workspace:

- **Local**: Quick tasks in your current working copy
- **Worktree**: Best for parallel agent work with isolation
- **SSH**: Heavy workloads, security, or remote infrastructure

## Key Concepts

- **Isolation**: Each workspace has independent working changes and Git state
- **Branch flexibility**: Workspaces can switch branches, enter detached HEAD state, or create new branches as needed
- **Parallel execution**: Run multiple workspaces simultaneously on different tasks
- **Shared commits**: Local workspaces (using worktrees) share commits with the main repository immediately

## Reviewing Code

Here are a few practical approaches to reviewing changes from workspaces, depending on how much you want your agent to interact with `git`:

- **Agent codes, commits, and pushes**: Ask agent to submit a PR and review changes in your git Web UI (GitHub, GitLab, etc.)
  - Also see: [Agentic Git Identity](/agentic-git-identity)
  - This is the preferred approach for `mux` development but requires additional care with repository security.
- **Agent codes and commits**: Review changes from the main repository via `git diff <workspace-branch>`, push changes when deemed acceptable.
- **Agent codes**: Enter worktree (click Terminal icon in workspace top bar), run `git add -p` and progressively accept changes into a commit.

## Reviewing Functionality

Some changes (especially UI ones) require the Human to determine acceptability. An effective approach for this is:

1. Ask agent to commit WIP when it's ready for Human review
2. Human, in main repository, checks out the workspace branch in a detached HEAD state: `git checkout --detach <workspace-branch>` (for local workspaces)

**Note**: For local workspaces, this workflow uses the detached HEAD state because the branch is already checked out in the workspace and you cannot check out the same branch multiple times across worktrees.

If you want faster iteration in between commits, you can hop into the workspace directory and run a dev server (e.g. `bun dev`) there directly and observe the agent's work in real-time.

---

See the specific workspace type pages for detailed setup and usage instructions.
