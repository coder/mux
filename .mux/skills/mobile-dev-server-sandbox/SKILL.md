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

### Preferred: one command for backend + proxy + mobile web

```bash
BACKEND_PORT=3900 \
VITE_PORT=5174 \
MOBILE_CORS_PROXY_PORT=3901 \
KEEP_SANDBOX=1 \
make mobile-sandbox
```

This starts:

- isolated backend sandbox (`dev-server-sandbox`) on `127.0.0.1:3900`
- local CORS proxy on `127.0.0.1:3901` → forwards to backend
- Expo web app on `http://localhost:8081`

Why the proxy exists:

- backend origin validation for `/orpc` is intentionally strict
- mobile web and backend use different origins in dev (`:8081` vs `:3900`)
- proxy keeps backend strictness while enabling local browser-based mobile UI testing

### Manual path (if you need separate terminals)

1. Start isolated backend sandbox

```bash
BACKEND_PORT=3900 \
VITE_PORT=5174 \
KEEP_SANDBOX=1 \
make dev-server-sandbox
```

2. Start local mobile CORS proxy

```bash
MOBILE_BACKEND_PORT=3900 \
MOBILE_CORS_PROXY_PORT=3901 \
# Optional when the mobile origin is not localhost:8081:
# MOBILE_CORS_ALLOWED_ORIGINS="http://localhost:8081,http://127.0.0.1:8081"
make mobile-cors-proxy
```

3. Start Expo web

```bash
EXPO_PUBLIC_BACKEND_URL=http://127.0.0.1:3901 make mobile-web
```

> `EXPO_PUBLIC_BACKEND_URL` now feeds Expo `extra.mux.baseUrl` defaults. Settings can still override it.

### Pair connection settings in app settings

In the mobile UI (`http://localhost:8081`):

- open **Settings**
- set Base URL to `http://127.0.0.1:3901` (proxy)
- clear Auth Token (or leave it empty)

After this, the URL persists in app storage.

## Agent workflow checklist

Copy this checklist and keep it updated while working:

```text
Mobile sandbox progress:
- [ ] Step 1: Start backend + proxy + mobile (`make mobile-sandbox`)
- [ ] Step 2: Verify Base URL points to proxy (:3901) and token is empty
- [ ] Step 3: Verify project/workspace list loads
- [ ] Step 4: Implement UI change
- [ ] Step 5: Re-verify via Chrome MCP + screenshots
```

## Chrome MCP prerequisites

- Ensure Google Chrome is installed and discoverable by MCP.
- If MCP says Chrome executable is missing, install Chrome before retrying.
- Avoid killing Chrome processes manually (`pkill`, `kill -9`) while using MCP; restart the workspace instead if MCP gets wedged.

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

Then run a proxy host reachable from the device and set mobile Base URL to that proxy URL.

## Validation loop (do not skip)

1. Backend reachable:
   - `http://127.0.0.1:3900/health` responds
2. Proxy reachable:
   - `http://127.0.0.1:3901/health` responds
3. Mobile connected:
   - project list loads without auth/CORS errors
4. Streaming works:
   - open workspace and confirm live chat updates
5. If any check fails, fix config and re-run the same checks.

## Troubleshooting

- **Unexpected auth errors**: this sandbox flow is no-auth; confirm token is empty.
- **`Failed to fetch` immediately after changing settings**: press **Retry** once after returning from Settings; initial fetch may still reflect stale state.
- **`Origin not allowed` from proxy**: include your mobile web origin in `MOBILE_CORS_ALLOWED_ORIGINS`.
- **Connection refused**: wrong port or backend/proxy not running.
- **CORS 403 from backend**: verify Base URL is proxy `:3901` (not backend `:3900`).
- **Works on desktop browser, fails on real device**: device cannot use `localhost`; use LAN/VPN IPs.
- **Sandbox vanished after exit**: re-run with `KEEP_SANDBOX=1`.

## Implementation references

Use these files when behavior needs to be confirmed:

- `scripts/dev-server-sandbox.ts`
- `scripts/mobile-cors-proxy.ts`
- `mobile/src/orpc/client.ts`
- `mobile/src/contexts/AppConfigContext.tsx`
- `mobile/src/shims/backendBaseUrl.ts`
- `mobile/app.config.js`
- `mobile/metro.config.js`
- `src/node/orpc/server.ts`
- `src/node/services/serverLockfile.ts`
- `Makefile` targets: `mobile-sandbox`, `mobile-cors-proxy`, `dev-server-sandbox`, `mobile-web`, `test-mobile`, `typecheck-react-native`
