---
name: pull-requests
description: Guidelines for creating and managing Pull Requests in this repo
---

# Pull Request Guidelines

## Attribution Footer

Public work (issues/PRs/commits) must use 🤖 in the title and include this footer in the body:

```md
---

_Generated with `mux` • Model: `<modelString>` • Thinking: `<thinkingLevel>` • Cost: `$<costs>`_

<!-- mux-attribution: model=<modelString> thinking=<thinkingLevel> costs=<costs> -->
```

Always check `$MUX_MODEL_STRING`, `$MUX_THINKING_LEVEL`, and `$MUX_COSTS_USD` via bash before creating or updating PRs—include them in the footer if set.

## Lifecycle Rules

- Before submitting a PR, ensure the branch name reflects the work and the base branch is correct.
  - PRs are always squash-merged into `main`.
  - Often, work begins from another PR's merged state; rebase onto `main` before submitting a new PR.
- Reuse existing PRs; never close or recreate without instruction.
- Force-push minor PR updates; otherwise add a new commit to preserve the change timeline.
- If a PR is already open for your change, keep it up to date with the latest commits; don't leave it stale.
- When updating a PR, ensure the title and body describe the **entire** diff against the base branch—not just the most recent commit or push.
- Never enable auto-merge or merge into `main` yourself. The user must explicitly merge PRs.

## CI & Validation

- Use `wait_pr_checks` only as a **last-step** helper when there's no more useful local work left.
- Prefer local validation first (e.g., `make static-check` or a targeted test subset) because CI waiting can take 10+ minutes.
- After local validation is done and no useful work remains, run `./scripts/wait_pr_checks.sh <pr_number>`.
- If asked to fix an issue in CI, first replicate it locally, get it to pass locally, then use `wait_pr_checks`.

## Status Decoding

| Field              | Value         | Meaning             |
| ------------------ | ------------- | ------------------- |
| `mergeable`        | `MERGEABLE`   | Clean, no conflicts |
| `mergeable`        | `CONFLICTING` | Needs resolution    |
| `mergeStateStatus` | `CLEAN`       | Ready to merge      |
| `mergeStateStatus` | `BLOCKED`     | Waiting for CI      |
| `mergeStateStatus` | `BEHIND`      | Needs rebase        |
| `mergeStateStatus` | `DIRTY`       | Has conflicts       |

If behind: `git fetch origin && git rebase origin/main && git push --force-with-lease`.

## Codex Review Workflow

When posting multi-line comments with `gh` (e.g., `@codex review`), **do not** rely on `\n` escapes inside quoted `--body` strings (they will be sent as literal text). Prefer `--body-file -` with a heredoc to preserve real newlines:

```bash
gh pr comment <pr_number> --body-file - <<'EOF'
@codex review

<message>
EOF
```

### Handling Codex Comments

Use these scripts to check, resolve, and wait on Codex review comments:

- `./scripts/check_codex_comments.sh <pr_number>` — Lists unresolved Codex comments (both regular comments and review threads). Outputs thread IDs needed for resolution.
- `./scripts/resolve_pr_comment.sh <thread_id>` — Resolves a review thread by its ID (e.g., `PRRT_abc123`).
- `./scripts/wait_pr_codex.sh <pr_number>` — Waits for Codex to respond to the latest `@codex review` request. When the PR looks good, Codex leaves an explicit approval comment (e.g., it will say `Didn't find any major issues`).

When Codex leaves review comments, you **must** address them before the PR can merge:

1. Push your fixes
2. Resolve each review thread: `./scripts/resolve_pr_comment.sh <thread_id>`
3. Comment `@codex review` to re-request review
4. Run `./scripts/wait_pr_codex.sh <pr_number>` to wait for the next Codex response (either new comments to address, or an explicit approval comment)

## PR Title Conventions

- Title prefixes: `perf|refactor|fix|feat|ci|tests|bench`
- Example: `🤖 fix: handle workspace rename edge cases`
- Use `tests:` for test-only changes (test helpers, flaky test fixes, storybook)
- Use `ci:` for CI config changes

## PR Bodies

### Structure

PR bodies should generally follow this structure; omit sections that are N/A or trivially inferable from the code.

- Summary
  - Single-paragraph executive summary of the change
- Background
  - The "why" behind the change
  - What problem this solves
  - Relevant commits, issues, or PRs that capture more context
- Implementation
  - Explain anything novel or unclear about the implementation approach
  - Keep it generally high-level and architectural
- Validation
  - Steps taken to prove the change works as intended
  - Avoid boilerplate like `ran tests`; include this section only for novel, change-specific steps
  - Do not include steps implied by passing PR checks
- Risks
  - PRs that touch intricate logic must include an assessment of regression risk
  - Explain regression risk in terms of severity and affected product areas
- Pains
  - Only include for non-trivial changes that that took multiple iteration cycles
  - Explain codebase or environment pains that slowed down planning, implementation, or validation

### Edits

Prefer storing the body in an out-of-tree file such as `/tmp/pr-<num>.txt`, using
file edit tools to modify it, and then `gh pr edit [num] --body-file <file>` to update it.

When updating the PR body, consider condensing information that is no longer important
into a toggle.

## Upkeep

Once the code is pushed to the remote (even if not yet a Pull Request), do your best to commit
and push all changes before responding to ensure its visible to the user. Commits on the working branch
are for yourself to understand the change, they do not have to follow repository conventions as the
PR body and title become the commit subject and body respectively.

Whenever generating a compaction summary, include whether or not a Pull Request was opened
and the general state of the remote (e.g. CI checks, known reviews, divergence).
