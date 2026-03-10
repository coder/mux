export const FLOW_PROMPTS_DIR = ".mux/prompts";
export const FLOW_PROMPT_AUTO_SEND_MODES = ["off", "end-of-turn"] as const;

export type FlowPromptAutoSendMode = (typeof FLOW_PROMPT_AUTO_SEND_MODES)[number];

function getFlowPromptFilenameStem(workspaceName: string): string {
  const trimmedName = workspaceName.trim();
  if (trimmedName.length === 0) {
    return "workspace";
  }

  // In-place workspaces use an absolute path as their name, so collapse any path-like
  // workspace identifier to a stable basename before turning it into a repo filename.
  const withoutTrailingSeparators = trimmedName.replace(/[\\/]+$/g, "");
  const lastPathSegment = withoutTrailingSeparators
    .split(/[\\/]+/)
    .filter(Boolean)
    .at(-1);
  const filenameStem = (lastPathSegment ?? withoutTrailingSeparators).replace(/[:]/g, "-");

  return filenameStem.length > 0 ? filenameStem : "workspace";
}

export function getFlowPromptRelativePath(workspaceName: string): string {
  return `${FLOW_PROMPTS_DIR}/${getFlowPromptFilenameStem(workspaceName)}.md`;
}

export function getFlowPromptPathMarkerLine(flowPromptPath: string): string {
  return `Flow prompt file path: ${flowPromptPath} (MUST use this exact path string for tool calls; do NOT rewrite it into another form, even if it resolves to the same file)`;
}
