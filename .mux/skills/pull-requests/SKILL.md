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
- Never enable auto-merge or merge into `main` yourself. The user must explicitly merge PRs.

## CI & Validation

- After pushing, you may use `./scripts/wait_pr_checks.sh <pr_number>` to wait for CI to pass.
- Use `wait_pr_checks` only when there's no more useful work to do.
- Waiting for PR checks can take 10+ minutes, so prefer local validation (e.g., run a subset of integration tests) to catch issues early.

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

If Codex left review comments and you addressed them:

1. Push your fixes
2. Resolve the PR comment
3. Comment `@codex review` to re-request review
4. Re-run `./scripts/wait_pr_checks.sh <pr_number>` and `./scripts/check_codex_comments.sh <pr_number>`

## PR Title Conventions

- Title prefixes: `perf|refactor|fix|feat|ci|tests|bench`
- Example: `🤖 fix: handle workspace rename edge cases`
- Use `tests:` for test-only changes (test helpers, flaky test fixes, storybook)
- Use `ci:` for CI config changes

## PR Bodies

### Structure

PR bodies should generally follow this structure; omit sections that are N/A or trivially inferable for the change.

- Summary
  - Single-paragraph executive summary of the change
- Background
  - The "why" behind the change
  - What problem this solves
  - Relevant commits, issues, or PRs that capture more context
- Implementation
- Validation
  - Steps taken to prove the change works as intended
  - Avoid boilerplate like `ran tests`; include this section only for novel, change-specific steps
  - Do not include steps implied by passing PR checks
- Risks
  - PRs that touch intricate logic must include an assessment of regression risk
  - Explain regression risk in terms of severity and affected product areas
