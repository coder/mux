# mux Mobile App

Expo React Native app for mux - connects to mux server via ORPC over HTTP with SSE streaming.

## Requirements

- **Expo SDK 54** with **React Native 0.81**
- Node.js 20.19.4+
- For iOS: Xcode 16+ (for iOS 26 SDK)
- For Android: Android API 36+

## Development

### Quick Start (Expo Go)

**Note**: Expo Go on SDK 54 has limitations with native modules. For full functionality, use a development build (see below).

```bash
cd mobile
bun install
bun start
```

Scan the QR code in Expo Go (must be SDK 54).

### Development Build (Recommended)

For full native module support:

```bash
cd mobile
bun install

# iOS
bunx expo run:ios

# Android
bunx expo run:android
```

This creates a custom development build with all necessary native modules baked in.

### Web Development (Agent Testing)

Use Expo web as a local testing surface for AI agents.

```bash
make mobile-web
# or
cd mobile && bun run web
```

Agents can interact with the UI via Chrome MCP using mobile viewport emulation:

```text
chrome_navigate_page → http://localhost:8081
chrome_emulate → viewport: 390x844, deviceScaleFactor: 3, isMobile: true, hasTouch: true
chrome_take_snapshot → verify UI elements
```

Known web limitations:

- Secure storage is not encrypted on web (uses `localStorage`)
- Native haptics/vibration are unavailable
- `ActionSheetIOS` falls back to `Modal` on web
- SSE streaming uses the browser global `fetch` instead of `expo/fetch`

This is a development/testing workflow for AI agent interaction, not a production web app.

## Configuration

Edit `app.json` to set your server URL and auth token:

```json
{
  "expo": {
    "extra": {
      "mux": {
        "baseUrl": "http://<your-tailscale-ip>:3000",
        "authToken": "your_token_here"
      }
    }
  }
}
```

## Server Setup

Start the mux server with auth (optional):

```bash
# In the main mux repo
MUX_SERVER_AUTH_TOKEN=your_token make dev-server BACKEND_HOST=0.0.0.0 BACKEND_PORT=3000
```

The mobile app will:

- Call APIs via POST `/ipc/<channel>` with `Authorization: Bearer <token>`
- Subscribe to workspace events via WebSocket `/ws?token=<token>`

## Features

- Real-time chat interface with streaming responses
- **Message editing**: Long press user messages to edit (truncates history after edited message)
- Provider configuration (Anthropic, OpenAI, etc.)
- Project and workspace management
- Secure credential storage

## Architecture

- **expo-router** for file-based routing
- **@tanstack/react-query** for server state
- **WebSocket** for live chat streaming
- Thin fetch/WS client in `src/api/client.ts`

## Troubleshooting

**"TurboModuleRegistry" errors in Expo Go**: This happens because Expo Go SDK 54 doesn't include all native modules. Build a development build instead:

```bash
bunx expo prebuild --clean
bunx expo run:ios  # or run:android
```

**Version mismatch**: Ensure Expo Go is SDK 54 (check App Store/Play Store for latest).

**Connection refused**: Make sure the mux server is running and accessible from your device (use your machine's Tailscale IP or local network IP, not `localhost`).
