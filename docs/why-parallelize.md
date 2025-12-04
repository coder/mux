---
title: Why Parallelize?
description: Use cases for running multiple AI agents in parallel
---

Here are some specific use cases we enable:

- **Contextual continuity between relevant changes**:
  - e.g. create a workspace for `code-review`, `refactor`, and `new-feature`
- **GPT-5-Pro**: use the slow but powerful GPT-5-Pro for complex issues
  - Run in the background for hours on end
  - The stream will automatically resume after restarts or intermittent connection issues. We show
    a subtle indicator when the model completes.
- **A/B testing**: test a variety of approaches to the same problem,
  abandon the bad ones.
- **Tangent management**: launch tangents in `mux` away from main work
