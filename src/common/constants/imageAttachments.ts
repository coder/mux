export const SVG_MEDIA_TYPE = "image/svg+xml";

// Large SVGs can cause provider request failures when we inline SVG as text.
// Keep this conservative so users get fast feedback at attach-time.
export const MAX_SVG_TEXT_CHARS = 50_000;
