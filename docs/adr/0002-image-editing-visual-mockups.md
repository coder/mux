---
title: Image Editing Uses a Separate General-Purpose Tool
description: Architecture decision for Mux's experimental image editing tool and edited image display messages
status: accepted
---

# 0002. Image Editing Uses a Separate General-Purpose Tool

## Status

Accepted

## Context

Mux already has an experimental `image_generate` tool for text-to-image generation. Screenshot-driven UI workflows need a related but different capability: an agent should be able to take a local image, such as a UI screenshot, and produce a visual edit mockup from a prompt.

Editing an existing image has a different privacy boundary from generation. Text-to-image sends only prompt text to the configured image provider, while image editing uploads a local file from the active runtime. That file may include sensitive pixels and embedded metadata. The product model therefore needs explicit upload consent and clear separation between visual mockups and implementation work.

## Decision

Mux will add general-purpose image editing through a separate model-callable `image_edit` tool. The tool edits exactly one PNG, JPEG, or WebP source image by path and returns edited image artifacts. When the source is a product screenshot or UI image, the output is a **Visual Edit Mockup**: a design reference artifact only, not source code, a direct UI mutation, or an authoritative implementation plan.

`image_edit` is distinct from `image_generate`, but both tools share the same user-facing Image Tools experiment, configured image model, max-images-per-call cap, artifact conventions, and tool-side image-model usage reporting path. Internal configuration names may remain generation-oriented until a broader cleanup justifies the churn. The v1 image-upload consent boolean lives inside the existing `imageGeneration` config object as `allowImageUploadsForEditing`.

The Image Tools setting has one main experiment toggle plus subordinate image-upload consent. Image generation requires the main toggle. `image_edit` is hidden unless both the main toggle and `allowImageUploadsForEditing` are enabled. Upload consent is separate because editing uploads local images or screenshots to the configured image provider.

The first version validates source type from actual decoded bytes/metadata rather than extension. It follows symlinks through the runtime, records both the requested path and resolved real path for UI provenance, and rejects unsupported or unreadable images before provider calls. It does not attempt automatic screenshot redaction or metadata stripping; source images are uploaded as-is.

Edited outputs are saved as runtime artifacts under a separate `edited_images` area with generated-style filenames. Extensions are selected from provider media type first, requested output format second, and PNG fallback. Bounded output thumbnails are persisted for transcript preview and stripped from model-visible tool output. Thumbnail generation failures keep the edited image result and add warnings.

The result uses a separate top-level `ImageEditToolResult` schema that shares common image artifact schema pieces with `ImageGenerateToolResult`. It records the edit prompt, requested source path, resolved real source path, source file size, source dimensions, output dimensions detected from actual output bytes, edited image paths, provider revised prompts when available, and warnings. V1 does not persist a source thumbnail. The display shows the requested source path by default and reveals the resolved real path in details only when different.

Successful `image_edit` outputs render as a first-class `edited-image` display message derived from persisted tool results, mirroring generated-image display rows. Pending, failed, malformed, interrupted, or hook-augmented edit calls continue to render as normal tool rows.

## Alternatives Considered

### Expand `image_generate` to accept input images

This was rejected because generation and editing have different user promises, privacy boundaries, and tool-selection semantics. A separate tool gives agents and users a clearer mental model.

### Direct OpenAI image-edit API calls

This was rejected for v1 because the installed AI SDK already routes image prompts with input images through the provider edit path while preserving Mux's existing model configuration, policy, usage reporting, and artifact flow.

### Masks and multi-image references

These were deferred because the initial product goal is prompt-based editing of one source image. Masks and multi-image references add provenance, UI, validation, and provider-specific complexity.

### Saving edited images directly into the workspace

This was rejected because most edit iterations are disposable and should not pollute the git working tree. Mux saves runtime artifacts by default, and agents copy selected final assets into the workspace only when the user wants them used by the project.

## Consequences

- Users opt into image editing separately from text-to-image generation.
- Agents can create visual mockups from screenshots without claiming to implement UI changes.
- Source image uploads can include arbitrary runtime-readable image files, so settings, docs, and tool guidance must warn about sensitive pixels and embedded metadata.
- Plan and Explore agents do not receive image editing by default.
- Future work can add masks, multi-image references, artifact indexing, cleanup, redaction, or a persisted edited-image event without changing the initial domain model.
