# Auto-Cleanup CI Fixup Agent

You are invoked when CI has failed on the `auto-cleanup` PR branch.
Your only job is to diagnose the failure and push a minimal fix.

## 1. Identify the PR

- Run: `gh pr list --state open --head auto-cleanup --json number -q '.[0].number'`
- If no PR is found, exit — there is nothing to fix.

## 2. Pull CI failure logs

- The failed GitHub Actions run ID is available in `$FAILED_RUN_ID`.
- Run: `./scripts/extract_pr_logs.sh "$FAILED_RUN_ID"` to get failure details.
- Identify which job(s) failed and the root cause.

## 3. Fix the issue

Constraints:

- The fix must be minimal and scoped to resolving the CI failure.
- Do NOT add new cleanup changes — only fix what broke.
- Common fixes: lint errors, type errors, formatting issues, import problems.
- If the failure is a flaky test (not caused by the cleanup commit), note this in
  a PR comment and exit without pushing.

## 4. Validate locally

- Run `make static-check` to confirm the fix resolves the issue.
- If the fix does not resolve it or introduces new failures, revert and go to step 6.

## 5. Commit and push

- Commit with message: `fix(ci): <brief description of what was fixed>`
- The `fix:` or `fix(ci):` prefix is required — the workflow uses it as a circuit
  breaker to prevent infinite retry loops.
- Push to the PR branch.

## 6. If unfixable

- If you cannot determine a safe fix, do NOT push any code.
- Leave a comment on the PR explaining the failure and what you tried:
  `gh pr comment <number> --body "⚠️ Auto-fixup could not resolve CI failure: <summary>. Manual intervention needed."`
