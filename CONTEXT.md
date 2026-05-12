# Context

## Glossary

### Image Generation Tool

A model-callable Mux tool that creates image artifacts by invoking an image generation service from Mux, rather than relying on the chat model's provider-native hosted tools.

### Image Generation Model

The configured model used by the Image Generation Tool to create images. This model is independent from the chat model selected for the agent conversation.

### Image Generation Skill

A model-facing Agent Skill that teaches prompting patterns, asset-handling workflows, and image-generation operating guidance. The skill is not itself the generation mechanism. The first built-in version should be richer than a minimal wrapper but should not include fallback CLI scripts or deferred capabilities as executable workflows.

### Built-in Image Generation Skill Scope

The first built-in Image Generation Skill is a single rich skill file. It includes prompting principles, use-case recipes, iteration guidance, and artifact policy, but no bundled scripts, fallback CLI documentation, or reference-file tree.

### Image Generation User Documentation

The first Image Generation Tool implementation includes a small user-facing documentation section in `docs/config/models.mdx` that explains the experimental setting, default model, pinned snapshot option, OpenAI credential requirement, runtime artifact behavior, and generate-only scope.

### Image Generation Operation

A specific capability exposed by the Image Generation Tool. The first experimental operation is text-to-image generation only; image editing, masks, batch generation, and transparent-background workflows are deferred.

### Image Generation Experiment

A user-visible, default-off experiment that gates whether the Image Generation Tool is exposed to agents. When disabled, the tool is not registered in the model-callable tool list.

### Image Generation Tool Availability

The Image Generation Tool is available to Exec-mode agents by default when the Image Generation Experiment is enabled. Built-in Plan and Explore agents remove the tool from their tool policy because image generation is costful and side-effectful.

### Image Generation Usage Reporting

The Image Generation Tool reports model usage through Mux's existing tool-side usage reporting path when the image provider returns usage metadata. Usage reporting failures must not fail an otherwise successful image generation.

### Image Generation Failure Handling

Image generation setup and API failures are reported as structured `image_generate` tool failures with actionable messages. Missing credentials, disabled providers, unsupported configured providers, invalid models, quota errors, and moderation errors do not block the whole message send and do not hide the tool when the experiment is enabled.

### Image Generation Policy Enforcement

The Image Generation Tool enforces Mux provider/model policy against the configured Image Generation Model before making provider calls. Policy-denied providers or models are reported as structured tool failures.

### Image Generation Confirmation Policy

The Image Generation Tool does not require per-call confirmation in the first experiment. Safety relies on the default-off experiment gate, Exec-only default availability, explicit-use tool instructions, and a configurable maximum image count per call.

### Image Generation Configuration

A nested app-level setting for defaults used by the Image Generation Tool. The first setting is the Image Generation Model stored as a normal `provider:model-id` model string, independent from provider credentials and the chat model.

### Image Generation Count Limit

The Image Generation Configuration includes `maxImagesPerCall`, defaulting to 4 with an allowed range of 1 through 10. If a tool call requests more images than the configured maximum, the tool returns a structured failure instead of silently clamping the request.

### Image Generation Provider Scope

The first experimental Image Generation Tool implementation supports OpenAI image models only. The configured model keeps the normal `provider:model-id` shape so future providers can be added without changing the domain term.

### Default Image Generation Model

The default Image Generation Model is `openai:gpt-image-2`. Users can override this setting in the Image Generation Configuration, including pinning to the snapshot `openai:gpt-image-2-2026-04-21` when they need stable model behavior.

### Image Generation Parameters

The first experimental `image_generate` operation exposes a deliberately small parameter set: prompt, image count, quality, and output format. The maximum image count is an experiment configuration value rather than a hardcoded tool constant. Provider-specific controls such as seed, aspect ratio, style, background, moderation overrides, compression, masks, and editing are deferred.

### Image Generation Artifact

A file produced by the Image Generation Tool and saved by default under the active runtime's temporary directory. Generated artifacts are not automatically project assets; agents must explicitly copy selected final images into the workspace when the user wants project-bound files.

### Image Generation Artifact Lifecycle

The first Image Generation Tool experiment does not implement explicit artifact cleanup. Runtime-temp generated artifacts are best-effort session artifacts; durable or project-bound images must be copied into the workspace.

### Image Generation Preview

Generated Image Display Messages render bounded thumbnails persisted in the `image_generate` tool result, while full-resolution image bytes live only in saved artifact files. Thumbnail generation failures should not fail an otherwise successful image generation.

### Generated Image Message

A first-class chat transcript item that represents image-generation output as a durable artifact rather than ordinary assistant text or generic tool JSON. The Image Generation Tool should produce Generated Image Messages for successful generations.

### Generated Image Display Message

The first implementation of a Generated Image Message is a frontend display message derived from a successful Image Generation Tool result. The persisted transcript source of truth remains the normal tool call and tool result; no new persisted chat part or stream protocol event is required for the first experiment.

### Generated Image Tool Row Replacement

When an `image_generate` tool call succeeds, the displayed transcript replaces the normal tool row with a Generated Image Display Message. Pending, executing, failed, interrupted, or redacted image-generation tool calls continue to render as normal tool rows.
