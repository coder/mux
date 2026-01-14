---
name: mux-testing-mux
description: Launch a second mux desktop instance using an isolated root/profile.
---

# mux testing mux (isolated roots / profiles)

Use this skill to launch a **second mux desktop instance on the same machine** for QA/validation.

This works by setting a distinct mux home (`MUX_ROOT`) *and* a distinct Electron `userData` directory (derived automatically).

## Quick start (packaged desktop)

1. Pick an isolated root directory (do **not** use your real `~/.mux`):

   - macOS/Linux: `/tmp/mux-test-1`
   - Windows: `%TEMP%\\mux-test-1`

2. Launch mux pointing at that root:

   ```bash
   mux --mux-root /tmp/mux-test-1
   # or
   mux desktop --mux-root /tmp/mux-test-1
   ```

Mux will automatically use:

- `muxHome = <MUX_ROOT>`
- `userData = <muxHome>/user-data`

So you can run multiple instances without collisions.

## Dev build (electron .)

If you’re running mux from the repo:

```bash
# in one terminal
make dev

# in another terminal
bunx electron . --mux-root /tmp/mux-test-1
```

If your dev server is on a non-default host/port, pass through the values your dev instance uses (e.g. `MUX_DEVSERVER_HOST`, `MUX_DEVSERVER_PORT`).

## Validate isolation

In the test root you should see separate state, e.g.:

- `<root>/server.lock`
- `<root>/user-data/` (Electron `userData`)
- `<root>/config.json`

## Cleanup

Delete the test root when you’re done:

```bash
rm -rf /tmp/mux-test-1
```
