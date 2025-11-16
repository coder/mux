# utils/main

**Main process utilities only.**

This directory contains utilities that depend on Node.js APIs (fs, path, os, etc.)
and can only be used in the main Electron process.

## Architecture Boundary

An ESLint rule prevents renderer code (components, hooks, contexts) from importing
from this directory. This ensures:

- No Node.js APIs leak into the browser bundle
- Clear separation between main and renderer concerns
- Early detection of architectural violations

## When to Add Code Here

Place utilities here if they:

- Use Node.js filesystem APIs (fs, fs/promises)
- Access OS-level information (os module)
- Perform system-level operations (child_process, etc.)

## When NOT to Use

If your utility:

- Works with pure data transformations → `src/utils/`
- Needs to be shared with renderer → `src/utils/` or use IPC
- Is frontend-specific → `src/utils/` or component helpers
