---
name: dev-server-sandbox
description: Run multiple isolated mux dev-server instances (temp MUX_ROOT + free ports)
---

# `dev-server` sandbox instances

`make dev-server` starts the mux backend server, which uses a lockfile at:

- `<MUX_ROOT>/server.lock` (defaults to `~/.mux-dev/server.lock` in development)

This means you can only run **one** dev server per mux root directory.

This skill documents the repo workflow for starting **multiple** dev-server instances in parallel (including from different git worktrees) by giving each instance its own temporary `MUX_ROOT`.

## Quick start

```bash
make dev-server-sandbox
```

## What it does

- Creates a fresh temporary `MUX_ROOT` directory
- Copies these files into the sandbox if present (unless disabled by flags):
  - `providers.jsonc` (provider config)
  - `config.json` (project list)
  - Each file is seeded independently from the first root that has it
    (`$MUX_ROOT`, then `~/.mux-dev`, then `~/.mux`), so a root with only
    `config.json` doesn't drop provider config
- Provider credential env vars are stripped from the server's env when they
  could silently override or mismatch the intended setup: all of them with
  `--clean-providers` (including Bedrock's `AWS_REGION` and
  `AWS_BEARER_TOKEN_BEDROCK`; shared AWS credentials like `AWS_PROFILE` are
  kept); otherwise only `*_BASE_URL` env vars that would shadow a seeded
  `providers.jsonc` entry that has an `apiKey` but no explicit `baseUrl`
  (API key env vars are always kept so env-key fallback still works)
- Picks free ports (`BACKEND_PORT`, `VITE_PORT`)
- Disables tutorials by default inside the sandbox (`MUX_ENABLE_TUTORIALS_IN_SANDBOX=1` opts back in)
- Allows all hosts (`VITE_ALLOWED_HOSTS=all`) so it works behind port-forwarding domains
- Runs `make dev-server` with those env overrides

## Options

```bash
# Start with a clean instance (do not copy providers or projects)
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers --clean-projects"

# Skip copying providers.jsonc
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-providers"

# Clear projects from config.json (preserves other config)
make dev-server-sandbox DEV_SERVER_SANDBOX_ARGS="--clean-projects"

# Use a specific root to seed from (default: per-file from $MUX_ROOT, ~/.mux-dev, ~/.mux)
SEED_MUX_ROOT=~/.mux-dev make dev-server-sandbox

# Keep the sandbox root directory after exit (useful for debugging)
KEEP_SANDBOX=1 make dev-server-sandbox

# Pin ports (must be different)
BACKEND_PORT=3001 VITE_PORT=5174 make dev-server-sandbox

# Re-enable tutorials for sandbox dogfooding
MUX_ENABLE_TUTORIALS_IN_SANDBOX=1 make dev-server-sandbox

# Override which make binary to use
MAKE=gmake make dev-server-sandbox
```

## Security notes

- `providers.jsonc` may contain API keys.
- The sandbox root directory is created on disk (usually under your system temp dir).
- This flow intentionally **does not** copy `secrets.json`.
