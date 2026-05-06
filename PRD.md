## Problem Statement

Mux users who use the **Built-in OpenAI Provider** currently send OpenAI model requests over the existing HTTP transport. OpenAI's Responses WebSocket transport can reduce setup overhead for streaming Responses API workflows, especially multi-step tool-calling runs, but Mux has no first-class way to opt into it. Users should be able to enable the **OpenAI WebSocket Transport** without breaking existing OpenAI, OpenAI-compatible, Chat Completions, Codex OAuth, or custom endpoint configurations.

## Solution

Add an optional, non-breaking **Built-in OpenAI Provider** setting named `webSocketTransportEnabled`. When enabled and the provider is using Responses wire format, Mux will use OpenAI's Responses WebSocket transport for eligible streaming Responses API requests. The setting will be exposed in the OpenAI provider settings UI near Wire Format, persisted with the provider configuration, and hidden in the UI while Chat Completions wire format is selected.

The implementation will use the published `@vercel/ai-sdk-openai-websocket-fetch` package rather than implementing the protocol in Mux. Mux will compose the package through a small, testable integration helper that preserves existing OpenAI fetch behavior, including Mux attribution, timeout behavior, DevTools header handling, and existing request normalization. WebSocket connections will live for one streaming model run, can be reused by internal AI SDK tool-calling steps, and will be explicitly closed when the run completes, errors, or is cancelled.

## User Stories

1. As a Mux user, I want to opt into OpenAI's WebSocket transport, so that eligible OpenAI Responses streams can use the lower-overhead transport.
2. As a Mux user, I want the WebSocket transport setting to be optional, so that existing OpenAI behavior remains unchanged unless I opt in.
3. As a Mux user, I want the WebSocket transport setting to persist in provider configuration, so that I do not need to re-enable it for every session.
4. As a Mux user, I want to configure WebSocket transport from the OpenAI provider settings UI, so that I do not need to edit configuration files manually.
5. As a Mux user, I want the setting to appear near Wire Format, so that I understand it is related to Responses versus Chat Completions behavior.
6. As a Mux user, I want the UI to explain that the WebSocket transport is experimental, so that I understand the risk of endpoint failures.
7. As a Mux user, I want the UI to warn that unsupported endpoints may fail, so that failures after enabling the setting are understandable.
8. As a Mux user, I want the WebSocket transport control to be hidden when Chat Completions wire format is selected, so that I do not expect Chat Completions requests to use WebSockets.
9. As a Mux user, I want switching to Chat Completions to preserve my saved WebSocket preference, so that switching back to Responses restores my intended WebSocket behavior.
10. As a Mux user, I want the setting to be non-breaking for existing configurations, so that upgrading Mux does not change transport behavior unexpectedly.
11. As a Mux user, I want Mux to avoid over-validating custom OpenAI base URLs, so that intentionally configured endpoints are not blocked by Mux-specific assumptions.
12. As a Mux user, I want unsupported WebSocket endpoints to fail normally, so that I can decide whether to disable the setting or fix the endpoint.
13. As a Mux user, I want Mux not to retry failed WebSocket requests over HTTP automatically, so that I do not accidentally duplicate provider-side work or tool-call flows.
14. As a Mux user, I want eligible multi-step tool-calling runs to reuse one WebSocket connection within the run, so that the transport can provide benefit across internal model steps.
15. As a Mux user, I want WebSocket connections to close when a stream completes, so that Mux does not leave unnecessary sockets open.
16. As a Mux user, I want WebSocket connections to close when a stream errors, so that failed streams do not leak resources.
17. As a Mux user, I want WebSocket connections to close when a stream is cancelled, so that interrupting a run cleans up transport resources.
18. As a Mux user, I want workspace title generation to clean up WebSocket resources too, so that background model uses do not leak sockets.
19. As a Mux user, I want Codex OAuth-routed requests to keep using the existing HTTP routing path, so that OAuth token injection, endpoint rewriting, and request normalization still run correctly.
20. As a Mux user, I want OpenAI-compatible providers to remain outside the WebSocket feature scope, so that provider-specific transport behavior does not accidentally affect unrelated providers.
21. As a Mux maintainer, I want the feature implemented through a small composition helper, so that WebSocket integration can be tested independently from the rest of provider construction.
22. As a Mux maintainer, I want the feature to use the published WebSocket transport package, so that Mux does not own protocol details already maintained upstream.
23. As a Mux maintainer, I want the provider model factory API shape to remain stable, so that adding WebSocket cleanup does not create broad call-site churn.
24. As a Mux maintainer, I want cleanup to be carried by a Mux-owned language-model cleanup symbol, so that stream owners can clean up resources without exposing package-specific details.
25. As a Mux maintainer, I want deterministic tests for config/schema behavior, so that the persisted opt-in field is accepted and invalid values are not surfaced.
26. As a Mux maintainer, I want deterministic tests for provider status behavior, so that the UI receives the WebSocket setting only when it is valid.
27. As a Mux maintainer, I want deterministic tests for provider construction behavior, so that WebSocket fetch is used only for enabled Responses-mode OpenAI requests.
28. As a Mux maintainer, I want deterministic tests for Chat Completions gating, so that the setting is inactive while Chat Completions wire format is selected.
29. As a Mux maintainer, I want lifecycle tests for cleanup, so that WebSocket close behavior is verified on completion, error, and cancellation paths.
30. As a Mux maintainer, I want UI tests for the OpenAI provider settings control, so that users can discover and correctly interpret the setting.
31. As a reviewer, I want optional live dogfooding instructions, so that the feature can be validated against a real OpenAI endpoint when credentials are available.
32. As a reviewer, I want screenshots and a recording from manual dogfooding when available, so that I can verify the setting's UI and runtime behavior without repeating every step.

## Implementation Decisions

- Add a persisted **Built-in OpenAI Provider** boolean setting named `webSocketTransportEnabled`.
- Treat absence of `webSocketTransportEnabled` as disabled so the change is non-breaking.
- Surface valid `webSocketTransportEnabled` values through the provider configuration information consumed by settings UI.
- Expose the setting in the OpenAI provider settings UI near Wire Format.
- Hide the UI control when Chat Completions wire format is selected.
- Preserve the saved WebSocket setting when Chat Completions wire format is selected; only make the transport inactive.
- Use risk-aware UI copy: the feature is experimental, uses OpenAI's Responses WebSocket transport for streaming Responses API requests, and unsupported endpoints may fail.
- Do not validate configured OpenAI base URLs before attempting WebSocket transport.
- Do not add automatic HTTP fallback for eligible WebSocket request failures.
- Do not broaden the feature to OpenAI-compatible providers in the initial implementation.
- Treat Codex OAuth as not a supported WebSocket scope; keep Codex OAuth-routed models on the existing HTTP routing path so OAuth token injection, endpoint rewriting, and request normalization still run.
- Use the published `@vercel/ai-sdk-openai-websocket-fetch` package instead of implementing the WebSocket protocol locally.
- Add a small deep module for composing OpenAI provider fetch behavior with the WebSocket transport. Its interface should hide package details behind simple inputs such as whether WebSocket mode is active and a returned close hook.
- Preserve existing OpenAI fetch behavior when composing the WebSocket transport, including request header handling, Mux attribution, DevTools header stripping, timeout behavior, custom fetch compatibility, and existing request normalization.
- Keep the provider model factory return shape unchanged.
- Add a Mux-owned language-model cleanup helper that can attach cleanup to a model, run cleanup once, and make double cleanup harmless.
- Run language-model cleanup in every stream owner that uses models created by the provider model factory, including main chat/agent streams and workspace title generation.
- Use per-stream WebSocket lifecycle: create for the stream run, allow reuse across internal AI SDK tool-calling steps, and close on completion, error, or cancellation.
- Do not create an ADR for this iteration because the feature is optional, reversible, and sufficiently covered by the glossary plus implementation comments.

## Testing Decisions

- Tests should focus on externally observable behavior rather than implementation details. Good tests should prove what users, provider status consumers, stream owners, or provider constructors observe; they should not assert private helper internals unless testing a deliberately extracted deep module through its public interface.
- Test the provider configuration schema accepts `webSocketTransportEnabled` as an optional boolean on the **Built-in OpenAI Provider**.
- Test invalid `webSocketTransportEnabled` values are not surfaced as valid provider status.
- Test provider status includes `webSocketTransportEnabled` when it is configured with a valid boolean.
- Test provider construction uses the WebSocket transport only when `webSocketTransportEnabled` is true and the effective wire format is Responses.
- Test provider construction does not activate WebSocket transport when the effective wire format is Chat Completions.
- Test the OpenAI provider settings UI renders a WebSocket transport control near Wire Format.
- Test the WebSocket transport UI control persists changes to provider configuration.
- Test the WebSocket transport UI control is hidden when Chat Completions wire format is selected.
- Test switching to Chat Completions does not delete the saved `webSocketTransportEnabled` value.
- Test the cleanup helper runs an attached cleanup once and tolerates repeated cleanup calls.
- Test main stream cleanup runs the language-model cleanup helper on completion, error, and cancellation paths.
- Test workspace title generation runs the language-model cleanup helper after its stream attempt completes or fails.
- Mock the published WebSocket transport package in lifecycle tests so tests do not require network access.
- Use existing provider configuration tests, provider service tests, provider model factory tests, settings UI tests, and stream lifecycle tests as prior art.
- Avoid tautological tests that only assert exact UI prose. UI tests should assert behavior such as visibility, disabled state, persisted mutations, and relationship to Wire Format.
- Live OpenAI dogfooding is optional and should not be required in CI because it depends on credentials, network access, endpoint support, and provider billing.

## Out of Scope

- Supporting OpenAI-compatible providers with WebSocket transport.
- Implementing the WebSocket protocol directly in Mux.
- Process-wide or cross-stream WebSocket connection caching.
- Automatic HTTP fallback after WebSocket failures.
- Base URL validation or URL derivation for custom endpoints.
- A separate custom WebSocket URL setting.
- Request-level or workspace-level overrides for WebSocket transport.
- Guaranteeing Codex OAuth WebSocket support.
- Adding an ADR for this initial opt-in implementation.
- Making live OpenAI WebSocket tests part of required automated validation.

## Further Notes

### Acceptance Criteria

- Existing OpenAI users see no transport behavior change unless `webSocketTransportEnabled` is explicitly enabled.
- The **Built-in OpenAI Provider** configuration accepts and persists `webSocketTransportEnabled` as an optional boolean.
- The OpenAI provider settings UI exposes the setting near Wire Format.
- The UI hides the setting while Chat Completions wire format is selected and preserves the saved value.
- Enabled Responses-mode OpenAI streams use the published WebSocket transport through Mux's composition layer.
- Chat Completions-mode OpenAI streams do not activate the WebSocket transport.
- WebSocket failures surface normally without automatic HTTP fallback.
- WebSocket resources are closed on stream completion, error, and cancellation for all stream owners that use provider-created models.
- Deterministic automated tests cover config, provider status, provider construction, UI gating, and cleanup lifecycle behavior.

### Dogfooding Plan

1. Start the Mux dev environment with an OpenAI-capable provider configuration.
2. Open Settings and navigate to Providers, then expand the OpenAI provider settings.
3. Verify the WebSocket transport control appears near Wire Format with experimental/risk-aware helper copy.
4. With Responses wire format selected, enable WebSocket transport and confirm the provider configuration persists the setting.
5. Send a short prompt using an OpenAI Responses model and verify the response streams successfully, or that an unsupported endpoint failure is surfaced clearly.
6. Switch Wire Format to Chat Completions and verify the WebSocket transport control is hidden while the saved preference is preserved.
7. Switch Wire Format back to Responses and verify the previously saved WebSocket preference is still reflected.
8. Interrupt or cancel a streaming response and verify the app remains stable and no follow-up stream is blocked by leaked transport state.
9. Capture screenshots of the settings UI in enabled and Chat Completions-hidden states.
10. Capture a short recording of enabling the setting, sending a prompt, and switching Wire Format to demonstrate the complete reviewer-visible flow.

### Issue Tracker Note

If this PRD is later published to the issue tracker, apply the `needs-triage` label so it enters normal triage.
