---
title: Runtimes
description: Configure where and how mux executes agent workspaces
---

Runtimes determine where and how mux executes agent workspaces.

| Runtime                           | Isolation                                  | Best For                                 |
| --------------------------------- | ------------------------------------------ | ---------------------------------------- |
| **[Local](/runtime/local)**       | All workspaces share the project directory | Quick edits to your working copy         |
| **[Worktree](/runtime/worktree)** | Each workspace gets its own directory      | Running multiple agents in parallel      |
| **[SSH](/runtime/ssh)**           | Remote execution over SSH                  | Security, performance, heavy parallelism |

## Choosing a Runtime

When creating a workspace, select the runtime from the dropdown in the workspace creation UI.

## Init Hooks

[Init hooks](/init-hooks) and agent bash tool executions can detect the runtime type via the `MUX_RUNTIME` environment variable:

- `local` — Local runtime
- `worktree` — Worktree runtime
- `ssh` — SSH runtime

This lets your init hook adapt behavior, e.g., skip worktree-specific setup when running in local mode.
