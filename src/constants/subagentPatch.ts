// Untracked files may be arbitrarily large, so capture needs a hard disk-usage bound.
export const SUBAGENT_WORKTREE_PATCH_MAX_BYTES = 10 * 1024 * 1024;

// `git add` materializes whole blobs into the capture's temporary object dir
// before the capped diff produces any output, so staging needs its own bound:
// the diff cap alone would let a multi-gigabyte dirty file fill /tmp. Larger
// than the diff cap because a big tracked file with a small change stages a
// big blob yet can still produce a small, capturable diff.
export const SUBAGENT_WORKTREE_PATCH_MAX_STAGED_BYTES = 256 * 1024 * 1024;
