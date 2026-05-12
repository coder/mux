---
name: imagegen
description: Generate raster image artifacts for this workspace using Mux's experimental image generation tool
---

# Image Generation

Use this skill when the user asks to generate or create raster image artifacts: hero images, illustrations, product mockups, UI visuals, icons, game assets, textures, infographics, or visual variants.

## Current capability

Use the `image_generate` tool for text-to-image generation.

The first Mux image generation experiment is generate-only:

- No image editing.
- No masks or reference-image edits.
- No batch JSONL workflow.
- No transparent-background or chroma-key workflow.
- No fallback CLI scripts.

If the user asks for a deferred capability, explain the limitation and offer a generate-only alternative.

## Prompting principles

Preserve the user's intent. Do not expand a specific prompt into an over-authored creative brief.

When the prompt is generic, add useful visual detail:

- subject and setting
- style or medium
- composition and framing
- lighting and mood
- color palette
- constraints and avoid-list

Do not invent brand palettes, slogans, characters, logos, or text unless the user asked for them. For text in an image, quote the exact text and keep it short.

## Prompt structure

Use a concise prompt with optional sections:

```text
Primary request: ...
Subject: ...
Style/medium: ...
Composition/framing: ...
Lighting/mood: ...
Palette: ...
Text, verbatim: "..."
Constraints: ...
Avoid: ...
```

Only include sections that help. A one-sentence prompt is fine when the user already gave clear direction.

## Use-case recipes

### Website hero

Describe the product, audience, visual metaphor, aspect/framing needs, and any empty space needed for overlay text. Do not add copy unless requested.

### Product mockup

Describe the product surface, environment, camera angle, material, lighting, and brand-neutral constraints. Keep labels/logos out unless provided by the user.

### UI illustration

Describe the interface concept and mood without inventing a literal app screenshot unless requested. Prefer clean composition and readable visual hierarchy.

### Icon or logo concept

Generate concept art only. Do not claim the output is final brand identity. Keep shapes simple and avoid tiny text.

### Game asset or sprite concept

Specify subject, pose, perspective, style, background simplicity, and whether the result is concept art or a production asset.

### Infographic or diagram raster

Keep labels minimal. For precise diagrams, prefer Mermaid or SVG/code instead of raster image generation.

### Texture or background

Describe pattern scale, seamlessness if desired, material, palette, and whether the image should avoid obvious focal subjects.

## Variants and iteration

For variants, use `image_generate` with the requested count when it is within the configured maximum. If the request exceeds the configured maximum, ask for fewer images or tell the user to adjust Settings → Experiments → Image Generation Tool.

For refinements, generate a new image from an updated prompt. Do not claim to edit the previous output.

## Artifact handling

Generated full-resolution images are saved under the active runtime's temporary directory. These are best-effort session artifacts, not permanent project assets.

Preview or discarded images can remain in the runtime temp directory. When the user wants an image used by the project, copy the selected final image into the workspace and report the workspace path.

Keep generated originals unless the user explicitly asks to delete them.
