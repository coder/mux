---
title: Experimental Image Generation Tool
description: Architecture decision for Mux's experimental image generation tool and generated-image display messages
---

# 0001. Experimental Image Generation Uses a Mux-Executed Tool with Derived Display Messages

## Status

Accepted

## Context

Mux is adding an experimental image generation capability. The capability needs a configurable image model, must avoid surprising users with default-on costful behavior, and should fit Mux's existing tool, settings, runtime, and transcript systems.

The Codex CLI report described a layered design built around a model-facing image generation skill, a hosted OpenAI Responses image-generation tool, artifact saving, and optional fallback scripts. Mux has different constraints: image generation should work independently from the selected chat model, and the configured image model should be controlled from Mux settings.

## Decision

Mux will implement the first image generation experiment as a Mux-executed model-callable tool named `image_generate`, backed by OpenAI image models through the AI SDK image generation API. The default image model is `openai:gpt-image-1.5`, with `openai:gpt-image-1.5-2025-12-16` available for users who want a pinned snapshot.

The feature is gated behind a visible, default-off Image Generation Tool experiment. The experiment owns an app-level `imageGeneration` configuration object containing `modelString` and `maxImagesPerCall`.

The first tool operation is text-to-image generation only. It exposes prompt, image count, quality, and output format. Editing, masks, batch generation, transparent-background workflows, seed, aspect ratio, style, moderation overrides, and compression are deferred.

Generated full-resolution images are saved under the active runtime artifact directory. The persisted tool result stores saved paths plus bounded thumbnails for transcript preview. Full image bytes are not stored in chat history.

The frontend renders successful `image_generate` results as a first-class Generated Image Display Message derived from the persisted tool result. The persisted transcript source of truth remains the normal tool call and tool result; no new persisted chat part or stream protocol event is required for the first experiment. Pending, executing, failed, interrupted, or redacted image-generation calls continue to render as normal tool rows.

The tool is available to Exec-mode agents by default when the experiment is enabled. Built-in Plan and Explore agents remove it from their tool policies. The tool enforces Mux provider/model policy before provider calls and reports image-generation usage through existing tool-side usage reporting when provider metadata is available.

Mux will also ship a richer built-in `/imagegen` Agent Skill as a single built-in skill file. The skill will teach prompting principles, use-case recipes, iteration guidance, and artifact policy, but it will not include fallback CLI scripts or executable workflows for deferred capabilities.

## Alternatives Considered

### Hosted OpenAI Responses image-generation tool

This would mirror Codex's built-in path more closely. It was rejected for v1 because the image capability should be independent from the selected chat model, and the configured Image Generation Model should be the model that directly handles generation.

### Skill-only implementation

A skill without a Mux tool would provide guidance but no integrated artifact, settings, usage-reporting, or display path. It was rejected because the product goal is a configurable image generation capability, not only model instructions.

### Direct full image bytes in chat history

Persisting base64 output directly would make previews easy, but it would quickly bloat chat history. Mux will persist bounded thumbnails and keep full-resolution images as runtime artifacts instead.

### New persisted chat message or stream event

A fully new persisted item/event model may be appropriate later. It was deferred because a derived display message gives first-class UX while preserving existing replay, retry, and history compatibility for the experiment.

### Saving generated images directly into the workspace

This would make generated images immediately project-usable, but it would also pollute the git working tree with every preview or discarded variant. Mux will save to runtime temp by default and require agents to explicitly copy selected final assets into the workspace.

## Consequences

- Image generation is usable from non-OpenAI chat models because the image tool owns its own configured model.
- Users must opt into the experiment before the tool is exposed.
- Power users can raise the image-count cap within the configured range, while the default stays conservative.
- Generated-image transcript previews remain available even if runtime-temp full artifacts are later cleaned up outside Mux.
- Project-bound image assets require an explicit copy step into the workspace.
- Future work can add editing, masks, transparent workflows, provider adapters, artifact indexing, cleanup, or a persisted generated-image event without changing the initial domain model.
