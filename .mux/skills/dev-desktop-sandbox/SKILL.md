---
name: dev-desktop-sandbox
description: Run isolated mux desktop (Electron) instances (temp MUX_ROOT + free ports)
---

# Desktop (Electron) sandbox instances

`make dev` + `make start` (Electron) uses `MUX_ROOT` for persisted state (config, sessions, worktrees, etc.). Running multiple Electron instances against the same mux root is noisy and risky during development.

This skill documents the repo workflow for starting **multiple** desktop dev instances in parallel (including from different git worktrees) by giving each instance its own temporary `MUX_ROOT`.

## Quick start

```bash
make dev-desktop-sandbox
```

## What it does

- Creates a fresh temporary `MUX_ROOT` directory
- Copies these files into the sandbox if present:
  - `providers.jsonc` (provider config)
  - `config.json` (project list)
- Picks free ports:
  - Vite devserver port (used by the renderer)
  - Electron remote debugging port (optional)
- Runs `make dev` with:
  - `MUX_ROOT=<temp>`
  - `MUX_VITE_PORT=<free-port>`
- Waits for Vite to be reachable, then runs `make build-static` (Electron expects `dist/splash.html`)
- Launches Electron (`bunx electron .`) with:
  - `MUX_ROOT=<temp>`
  - `MUX_DEVSERVER_HOST=127.0.0.1`
  - `MUX_DEVSERVER_PORT=<vite-port>`
  - `MUX_SERVER_PORT=0` by default (avoids `EADDRINUSE` if your `config.json` pins `apiServerPort`)
  - `CMUX_ALLOW_MULTIPLE_INSTANCES=1` (so you can run alongside another dev instance)

## Options

```bash
# Use a specific root to seed from (defaults to $MUX_ROOT then ~/.mux-dev then ~/.mux)
SEED_MUX_ROOT=~/.mux-dev make dev-desktop-sandbox

# Keep the sandbox root directory after exit (useful for debugging)
KEEP_SANDBOX=1 make dev-desktop-sandbox

# Pin Vite port
VITE_PORT=5174 make dev-desktop-sandbox

# Control how long we wait for Vite to come up (ms)
VITE_READY_TIMEOUT_MS=120000 make dev-desktop-sandbox

# Enable/pin Electron remote debugging port (defaults to an auto-picked free port)
ELECTRON_DEBUG_PORT=9223 make dev-desktop-sandbox

# Disable Electron remote debugging entirely
ELECTRON_DEBUG_PORT=0 make dev-desktop-sandbox

# Override the internal API server port (defaults to 0/random for sandboxes)
MUX_SERVER_PORT=3772 make dev-desktop-sandbox

# Override which make binary to use
MAKE=gmake make dev-desktop-sandbox
```

## Optional: deeper Electron isolation (`MUX_E2E=1`)

Even with a unique `MUX_ROOT`, Electron's `userData` directory (localStorage, window state, single-instance lock, etc.) is not automatically relocated unless `MUX_E2E=1` is set.

If you want **full** isolation (including `userData`), run:

```bash
MUX_E2E=1 make dev-desktop-sandbox
```

## Security notes

- `providers.jsonc` may contain API keys.
- The sandbox root directory is created on disk (usually under your system temp dir).
- This flow intentionally **does not** copy `secrets.json`.
