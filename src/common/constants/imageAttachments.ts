export const SVG_MEDIA_TYPE = "image/svg+xml";

// Large SVGs can cause provider request failures when we inline SVG as text.
// Keep this conservative so users get fast feedback at attach-time.
export const MAX_SVG_TEXT_CHARS = 50_000;

// Conservative max dimension (pixels) for raster image attachments.
// OpenAI caps at 2000px always; Anthropic caps at 2000px for many-image (>20) requests.
// Resize at attach-time to avoid provider rejections that persist in history.
export const MAX_IMAGE_DIMENSION = 2000;
