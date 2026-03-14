import { getFlowPromptPathMarkerLine } from "@/common/constants/flowPrompting";

export function getFlowPromptFileHint(flowPromptPath: string, exists: boolean): string | null {
  if (!exists) {
    return null;
  }

  const exactPathRule = flowPromptPath.startsWith("~/")
    ? "You must use the flow prompt file path exactly as shown (including the leading `~/`); do not expand `~` or use alternate paths that resolve to the same file."
    : "You must use the flow prompt file path exactly as shown; do not rewrite it or use alternate paths that resolve to the same file.";

  return `${getFlowPromptPathMarkerLine(flowPromptPath)}

A flow prompt file exists at: ${flowPromptPath}. Flow prompt updates may arrive in chat as diffs or full snapshots, and they include the current \`Next\` heading when present. If the full flow-prompt context is not already clear from those updates or from chat history, read the full file.

${exactPathRule}`;
}
