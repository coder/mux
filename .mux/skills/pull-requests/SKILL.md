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

- Before submitting a PR, ensure the current branch is well-named to represent the work and the branch base is as expected.
    - PRs are always squash-merged into main
    - Often, users will begin work off the working state of another, merged PR. In such cases you may need to rebase the work onto main before submitting a new PR.
- Reuse existing PRs; never close or recreate without instruction.
- Force push minor PR updates, otherwise use a new commit to capture the timeline of the change.
- If a PR is already open for your change, keep it up to date with the latest commits; don't leave it stale.
- Never enable auto-merge or merge into `main` yourself. User must explicitely merge PRs into main themselves.

## CI & Validation

- After pushing you may use `./scripts/wait_pr_checks.sh <pr_number>` to wait until CI passes.
- Use `wait_pr_checks` as a final step when there is no more useful work to do.
- Waiting for PR checks can take 10+ minutes, prefer locally validating changes (e.g. running a subset of integration tests) before waiting for checks to catch issues early.

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

PR bodies should broadly follow the following structure, but you should omit sections that are N/A or trivially inferrable from a change.

- Summary
  - Single paragraph executive summary of the change
- Background
  - The "Why" behind the change
  - What problem is this solving
  - Relevant commits, issues, PRs the capture more of the context behind a change
- Implementation
- Validation
  - What steps were taken to prove this change works as intended
  - Avoid standard boilerplate like `ran tests`, only include this section if novel, change-specific steps were taken.
  - Do not include steps that are implied by the PR checks passing.
- Risks
  - PRs that touch intricate logic must include an assessment of regression risk
  - Regression risk should be explainined in terms of severity as well as affected product areas

