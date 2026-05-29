export function mergeAdditionalSystemInstructions(
  scratchpadContent: string,
  requestAdditionalSystemInstructions?: string
): string | undefined {
  const scratchpad = scratchpadContent.trim();
  const request = requestAdditionalSystemInstructions?.trim() ?? "";

  if (scratchpad.length === 0) return request.length > 0 ? request : undefined;
  if (request.length === 0) return scratchpad;

  // Frontend sends include the live scratchpad snapshot so a just-typed change
  // cannot race the backend disk write. The backend also reads the durable file;
  // avoid duplicating the scratchpad when both sources match.
  if (request === scratchpad || request.startsWith(`${scratchpad}\n\n`)) {
    return request;
  }

  return `${scratchpad}\n\n${request}`;
}
