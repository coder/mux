# Mux Provider Configuration

Mux provider configuration describes which model providers are available and how Mux routes model requests through them.

## Language

**Built-in OpenAI Provider**:
The first-party OpenAI provider settings surface in Mux, covering OpenAI API key and Codex OAuth configuration paths.
_Avoid_: OpenAI-compatible provider, GitHub Copilot provider

**Direct OpenAI API Key Path**:
The **Built-in OpenAI Provider** path that talks to OpenAI's platform API with an OpenAI API key.
_Avoid_: Codex OAuth path, OpenAI-compatible provider

**OpenAI WebSocket Transport**:
An optional transport for the **Built-in OpenAI Provider** that uses OpenAI's Responses WebSocket path for eligible streaming responses requests.
_Avoid_: WebSocket provider, OpenAI-compatible WebSocket transport

**webSocketTransportEnabled**:
The persisted opt-in flag that enables the **OpenAI WebSocket Transport** for eligible **Built-in OpenAI Provider** requests.
_Avoid_: transport, websocket, useWebSocketTransport

## Relationships

- The **OpenAI WebSocket Transport** belongs to the built-in OpenAI provider settings surface.
- Codex OAuth routing is not a supported **OpenAI WebSocket Transport** scope, and Mux does not add a special guard solely to protect it from an opt-in WebSocket attempt.
- The **OpenAI WebSocket Transport** applies only to eligible streaming Responses API requests.
- The **OpenAI WebSocket Transport** is inactive when the **Built-in OpenAI Provider** uses Chat Completions wire format.
- Switching to Chat Completions wire format preserves `webSocketTransportEnabled` but hides the UI control and disables the active WebSocket transport until Responses wire format is restored.
- A WebSocket connection lives for one streaming model run: it can be reused by internal tool-calling steps and is closed when the run completes, errors, or is cancelled.
- Eligible WebSocket request failures are surfaced to the user; Mux does not automatically retry them over HTTP.
- WebSocket transport behavior is verified with deterministic config, UI, provider factory, and lifecycle tests; live OpenAI dogfooding is optional when credentials are available.
- Mux uses the published `@vercel/ai-sdk-openai-websocket-fetch` package for the **OpenAI WebSocket Transport** instead of owning the WebSocket protocol locally.
- Mux composes **OpenAI WebSocket Transport** through a small helper that preserves existing OpenAI fetch behavior and exposes a close hook for stream lifecycle cleanup.
- Mux carries WebSocket cleanup on a Mux-owned language-model cleanup symbol so stream owners can run it in their existing cleanup paths without changing the provider model factory API shape.
- Every `streamText` owner that uses `createModel()`-returned models, including main streams and workspace title generation, runs the model cleanup helper in its stream cleanup path.
- The **OpenAI WebSocket Transport** is a persisted **Built-in OpenAI Provider** setting, not a request-level override.
- The OpenAI provider settings UI exposes `webSocketTransportEnabled` near Wire Format only while Responses wire format is selected.
- The OpenAI provider settings UI describes the **OpenAI WebSocket Transport** as experimental and warns that unsupported endpoints may fail.
- The **OpenAI WebSocket Transport** does not validate configured base URLs; if the selected endpoint does not support OpenAI's Responses WebSocket path, the first eligible request fails normally.

## Example dialogue

> **Dev:** "Should the **OpenAI WebSocket Transport** apply to OpenAI-compatible providers?"
> **Domain expert:** "No — it belongs only to the **Built-in OpenAI Provider** for the initial opt-in feature."

## Flagged ambiguities

- "OpenAI provider" can mean the **Built-in OpenAI Provider**, the **Direct OpenAI API Key Path**, or an OpenAI-compatible provider; resolved: this feature targets the **Built-in OpenAI Provider** settings surface only.
