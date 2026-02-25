---
name: mobile-dev-server-sandbox
description: Connects Mux mobile (Expo web/native) to an isolated dev-server sandbox with deterministic port setup, backend pairing, and Chrome MCP interaction. Use when implementing or validating mobile features against a sandboxed Mux backend.
---

# Mobile + `dev-server-sandbox`

Use this skill when work needs the mobile app connected to an isolated backend, especially for UI tasks in Expo web where an agent can interact through Chrome MCP.

## Important auth behavior in this workflow

`make dev-server-sandbox` delegates to `make dev-server`, and the dev server runs with `--no-auth`.

For this sandbox flow:

- leave mobile **Auth Token** empty
- do not expect token mismatch to be a valid failure mode
- only configure a token when intentionally testing an auth-enabled server path

## Quick start (deterministic)

Run these in separate terminals.

### 1) Start isolated backend sandbox

```bash
BACKEND_PORT=3900 \
VITE_PORT=5174 \
KEEP_SANDBOX=1 \
make dev-server-sandbox
```

Why this shape:

- fixed backend port removes guesswork
- isolated `MUX_ROOT` avoids collisions with other running mux instances
- `KEEP_SANDBOX=1` keeps temp state for debugging

### 2) Start mobile web against that backend

```bash
EXPO_PUBLIC_BACKEND_URL=http://127.0.0.1:3900 make mobile-web
```

### 3) Pair connection settings in app settings

In the mobile UI (`http://localhost:8081`):

- open **Settings**
- keep/save Base URL as `http://127.0.0.1:3900`
- clear Auth Token (or leave it empty)

After this, the URL persists in app storage.

## Agent workflow checklist

Copy this checklist and keep it updated while working:

```text
Mobile sandbox progress:
- [ ] Step 1: Start isolated backend (`make dev-server-sandbox`)
- [ ] Step 2: Start Expo web (`make mobile-web`)
- [ ] Step 3: Pair URL in Settings and clear token
- [ ] Step 4: Verify project/workspace list loads
- [ ] Step 5: Implement UI change
- [ ] Step 6: Re-verify via Chrome MCP + screenshots
```

## Chrome MCP loop (for UI work)

Use this exact order for reliable UI automation:

1. `chrome_navigate_page` → `http://localhost:8081`
2. `chrome_emulate` with mobile viewport:
   - width `390`
   - height `844`
   - `deviceScaleFactor: 3`
   - `isMobile: true`
   - `hasTouch: true`
3. `chrome_take_snapshot` to identify interactable elements
4. `chrome_click` / `chrome_fill` to drive flows
5. `chrome_take_screenshot` for visual confirmation after each meaningful step

## Optional: direct device testing (phone/tablet)

If testing from a physical device, expose backend on LAN:

```bash
BACKEND_HOST=0.0.0.0 \
BACKEND_PORT=3900 \
VITE_PORT=5174 \
KEEP_SANDBOX=1 \
make dev-server-sandbox
```

Then set mobile Base URL to a reachable machine IP (LAN/VPN/Tailscale), not `localhost`.

## Validation loop (do not skip)

1. Backend reachable:
   - `http://127.0.0.1:3900` responds
2. Mobile connected:
   - project list loads without auth errors
3. Streaming works:
   - open workspace and confirm live chat updates
4. If any check fails, fix config and re-run the same checks.

## Troubleshooting

- **Unexpected auth errors**: this sandbox flow is no-auth; confirm you are on the sandbox URL and clear any stale mobile Auth Token value.
- **Connection refused**: wrong port or backend not running.
- **Works on desktop browser, fails on real device**: device cannot use `localhost`; switch to LAN/VPN IP and ensure `BACKEND_HOST=0.0.0.0`.
- **Sandbox vanished after exit**: re-run with `KEEP_SANDBOX=1`.

## Implementation references

Use these files when behavior needs to be confirmed:

- `scripts/dev-server-sandbox.ts`
- `mobile/src/orpc/client.ts`
- `mobile/src/contexts/AppConfigContext.tsx`
- `mobile/src/shims/backendBaseUrl.ts`
- `mobile/metro.config.js`
- `src/node/services/serverService.ts`
- `src/node/services/serverLockfile.ts`
- `Makefile` targets: `dev-server-sandbox`, `mobile-web`, `test-mobile`, `typecheck-react-native`
