# Telemetry

mux collects anonymous usage telemetry to help us understand how the product is being used and improve it over time.

## Privacy Policy

- **No personal information**: We never collect usernames, project names, file paths, or code content
- **Random IDs only**: Only randomly-generated workspace IDs are sent (impossible to trace back to you)
- **No hashing**: We don't hash sensitive data because hashing is vulnerable to rainbow table attacks
- **Transparent data**: See exactly what data structures we send in [`src/common/telemetry/payload.ts`](https://github.com/coder/mux/blob/main/src/common/telemetry/payload.ts)

## What We Track

All telemetry events include basic system information:

- Application version
- Operating system platform (darwin, win32, linux)
- Electron version

### Specific Events

- **App Started**: When the app launches (includes first-launch flag)
- **Workspace Creation**: When a new workspace is created (workspace ID only)
- **Workspace Switching**: When you switch between workspaces (workspace IDs only)
- **Message Sending**: When messages are sent (model, mode, message length rounded to base-2)
- **Errors**: Error types and context (no sensitive data)

### What We DON'T Track

- Your messages or code
- Project names or file paths
- API keys or credentials
- Usernames or email addresses
- Any personally identifiable information

## Disabling Telemetry

To disable telemetry, set the `MUX_DISABLE_TELEMETRY` environment variable before starting the app:

```bash
MUX_DISABLE_TELEMETRY=1 mux
```

This completely disables all telemetry collection at the backend level.

## Source Code

For complete transparency, you can review the telemetry implementation:

- **Payload definitions**: [`src/common/telemetry/payload.ts`](https://github.com/coder/mux/blob/main/src/common/telemetry/payload.ts) - All data structures we send
- **Backend service**: [`src/node/services/telemetryService.ts`](https://github.com/coder/mux/blob/main/src/node/services/telemetryService.ts) - Server-side telemetry handling
- **Frontend client**: [`src/common/telemetry/client.ts`](https://github.com/coder/mux/blob/main/src/common/telemetry/client.ts) - Frontend to backend relay
- **Privacy utilities**: [`src/common/telemetry/utils.ts`](https://github.com/coder/mux/blob/main/src/common/telemetry/utils.ts) - Base-2 rounding helper
