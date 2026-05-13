---
name: imagegen
description: Create or edit raster image artifacts for this workspace using Mux's experimental Image Tools
---

# Image Tools

Use this skill when the user asks to generate raster image artifacts or edit an existing image: hero images, illustrations, product mockups, UI visuals, icons, game assets, textures, infographics, visual variants, or prompt-based edits to a local image path.

## Current capability

Use `image_generate` for text-to-image generation.

Use `image_edit` when the user asks to edit an existing local PNG, JPEG, or WebP image and the tool is available. If `image_edit` is not in your toolset, explain that image editing requires upload consent in Settings > Experiments > Image Tools and offer image generation or implementation guidance instead. The tool edits exactly one source image from a prompt and returns edited image artifacts. It does not capture screenshots, write code, plan implementation work, or verify UI changes; those steps belong to the calling workflow when the user explicitly asks for them.

Image editing uploads the selected source file to the configured image provider as-is, including embedded metadata. Do not upload incidental images, screenshots, secrets, or sensitive visual/metadata content unless image editing is requested or clearly required by the task.

Deferred capabilities:

- No masks or region-specific edits.
- No multi-image reference editing.
- No batch JSONL workflow.
- No transparent-background or chroma-key workflow.
- No fallback CLI scripts.

If the user asks for a deferred capability, explain the limitation and offer the closest prompt-based generate/edit alternative.

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
Subject/source: ...
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

### UI visual or screenshot edit

If the user provided or asked you to capture a screenshot, use separate screenshot tooling first, then call `image_edit` on that saved image path. Treat the edited output as a visual mockup only; do not claim it changed the product UI.

### Icon or logo concept

Generate concept art only. Do not claim the output is final brand identity. Keep shapes simple and avoid tiny text.

### Game asset or sprite concept

Specify subject, pose, perspective, style, background simplicity, and whether the result is concept art or a production asset.

### Infographic or diagram raster

Keep labels minimal. For precise diagrams, prefer Mermaid or SVG/code instead of raster image generation.

### Texture or background

Describe pattern scale, seamlessness if desired, material, palette, and whether the image should avoid obvious focal subjects.

## Variants and iteration

For variants, request the count the user asked for when it is within the configured maximum. If the request exceeds the configured maximum, ask for fewer images or tell the user to adjust Settings > Experiments > Image Tools.

Default to one output. Request multiple variants only when the user asks for variants or variants are clearly useful.

For prompt refinements to an existing image artifact, use `image_edit` only when the source image path is available and upload consent permits editing; otherwise use `image_generate` from an updated prompt.

## Artifact handling

Generated and edited full-resolution images are saved under runtime artifact directories. These are best-effort session artifacts, not permanent project assets.

Preview or discarded images can remain in the runtime artifact directory. When the user wants an image used by the project, copy the selected final image into the workspace and report the workspace path.

Keep originals unless the user explicitly asks to delete them.
