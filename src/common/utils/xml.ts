const XML_ENTITIES = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&apos;", "'"],
  ["&amp;", "&"],
] as const;

export function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function unescapeXml(value: string): string {
  // Keep &amp; last so already-escaped entities like &amp;lt; do not double-decode.
  let result = value;
  for (const [encoded, decoded] of XML_ENTITIES) {
    result = result.replaceAll(encoded, decoded);
  }
  return result;
}
