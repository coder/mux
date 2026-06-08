---
author: dcieslak19973
date: 2026-06-07
---

# Interactive PR Review Workspace

Status: Draft

## Problem

mux makes _producing_ code fast — spin up a workspace, an agent writes a change, open a PR. But **reviewing an incoming pull request is not a first-class flow.** To review a PR today you must:

- manually fetch its branch in a terminal (`gh pr checkout <n>` / fetch `refs/pull/<n>/head`), then create a workspace pointed at it;
- use a review surface built around "this workspace's own diff vs a base," not "an external PR under review"; and
- have no in-app way to submit _your_ review — the hunks you marked and comments you wrote in the review pane — back to the PR as a forge review. (An agent in the workspace can post comments via `gh`, and `ultrareview` can run an automated pass against a PR, but neither is the reviewer submitting their own pane review.)

Cross-fork PRs (a contributor's fork branch) have no entry point at all. As an increasing share of PRs are agent-authored, the bottleneck shifts from authoring to **review** — so this gap grows more costly over time.

## Goals

1. A first-class **"review a PR" workspace**: give mux a PR (URL or `owner/repo#<n>`) and get a workspace ready to review it.
2. **Cross-fork support** — fetch `refs/pull/<n>/head` even when the PR comes from a fork.
3. The PR **diff preloaded** in the review pane, based against the PR's base branch.
4. An **interactive human + agent review session** over a real checkout — navigate hunks, ask the agent grounded questions, run/verify the change, co-author comments.
5. **Push the review back** to the forge (inline comments + an overall verdict), with the workspace linked to the PR.

## Non-goals

- Not a PR triage/prioritization queue (separate concern).
- Not replacing the forge's review system — mux contributes a review; the forge stays the system of record.
- Not auto-approving or merging; the human owns the verdict (an agent may assist, never replace it).
- No broad multi-forge generality in v1 beyond a thin adapter seam (GitHub first; see Phasing).

## Proposed design

This is a **review posture** on mux's normal workspace (a worktree + agent chat + the existing Review tab), **not a new workspace type**. The new bits are PR _intake_ and _push-back_; everything else reuses what a workspace already has.

### Intake

- Accept a PR reference (URL or `owner/repo#<n>`) from the command palette / new-workspace surface.
- Resolve via the forge: head repo + ref (including forks), base ref, title/metadata.
- Fetch `refs/pull/<n>/head` (works for fork PRs) into the local project and open a worktree on that ref in a **review posture** (the normal workspace + Review tab, focused on the PR diff).

### Review surface (reuse what exists)

- Preload the immersive review pane (`ImmersiveReviewView` / `ReviewPanel` / `AssistedReviewHunk`) with the base set to the PR's base branch, so the reviewer gets the PR diff hunk-by-hunk with the existing affordances (navigate, mark-reviewed, pinned notes).

### Interactive session

- The workspace chat _is_ the review conversation: the human drives, the agent assists — grounded in the real checkout (answer "why does this do X / what calls this," cross-reference, propose tests, run/verify the change).
- Optionally run the existing `deep-review` pass for an automated first cut that the human curates. A reviewing agent **assists, never replaces** the human verdict.

### Push-back

- Post inline comments (mapped to file/line) plus an overall review (comment / request-changes / approve) to the forge.
- Persist a workspace↔PR link so the session is resumable and the review is traceable.

### Forge boundary

- Encapsulate `fetch-PR` + `post-review` behind a thin adapter; ship **GitHub first**. The same seam later admits other forges; v1 need not implement them.

## Reuses vs. new

- **Reuses:** the worktree/runtime model; the immersive review UI; agent chat + the `deep-review` skill; run/verify.
- **New:** PR intake (incl. cross-fork `refs/pull/<n>/head` fetch); a review posture that preloads diff-vs-PR-base; push-review-back to the forge; workspace↔PR linkage.

## Phasing

1. **Review posture + intake (same-repo branches, GitHub):** PR number → fetch → worktree → diff preloaded in the review pane. Review locally; comment out-of-band.
2. **Cross-fork fetch** (`refs/pull/<n>/head`) so fork PRs work.
3. **Push-back:** inline comments + verdict to GitHub from the session.
4. **Forge adapter** generalization behind the seam.

## Risks / open questions

- **Auth:** push-back needs a forge token (`gh`/PAT); degrade gracefully when absent (review still works, push-back disabled).
- **Inline-comment mapping:** anchoring in-app hunk annotations to forge inline positions (commit/line/side) is fiddly; may start with a single summary review before true inline comments.
- **Large diffs:** preload/perf for big PRs — reuse the existing review hydration gating.
- **Keep it review-shaped, not work-shaped:** a review workspace should default to a review posture rather than encouraging new commits onto the PR branch (unless the reviewer intends suggested edits).
- **Suggested changes:** should the agent draft suggested edits the reviewer pushes as GitHub "suggestions"? Likely phase 3+.
- **Review-only vs collaborative (commit guard):** offer a per-workspace setting (toggle/radio) that **bars commits/pushes to the checked-out branch**. Default it ON for the review-a-PR entry (review-only — read/annotate/run/comment, never write to the contributor's branch), and OFF for **collaborative** branches with multiple authors (a shared feature branch, or a PR you co-own) where pushing fixes is intended. Enforcement would be a client-side guardrail (disable commit affordances / block the commit tool) — bypassable via raw `git` in the terminal — so treat it as intent-signaling + footgun-prevention, not a hard lock.
