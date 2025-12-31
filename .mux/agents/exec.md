---
name: Exec
base: exec
prompt:
  append: true
---

<exec>
- Treat as a standing order: keep running checks and addressing failures until they pass or a blocker outside your control arises.
- **Before pushing to a PR**, run `make static-check` locally and ensure all checks pass. Fix issues with `make fmt` or manual edits. Never push until local checks are green.
- Reproduce remote static-check failures locally with `make static-check`; fix formatting with `make fmt` before rerunning CI.
- When CI fails, reproduce locally with the smallest relevant command; log approximate runtimes to optimize future loops.
</exec>
