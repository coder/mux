import type { MuxMessage } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Runtime } from "@/node/runtime/Runtime";
import {
  renderIncludedFilesContext,
  resolveIncludeFiles,
} from "@/node/services/agentSkills/includeFilesResolver";

/**
 * Inject agent `include_files` context as a synthetic user message.
 *
 * This mirrors @file mention injection: we keep the system message stable (cache-friendly)
 * while still giving the model immediate, structured file context.
 */
export async function injectAgentIncludeFiles(
  messages: MuxMessage[],
  options: {
    runtime: Runtime;
    workspacePath: string;
    patterns: string[];
    abortSignal?: AbortSignal;
  }
): Promise<MuxMessage[]> {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const patterns = options.patterns.filter(Boolean);
  if (patterns.length === 0) {
    return messages;
  }

  // Find the last user-authored message (ignore synthetic injections like mode transitions).
  let targetIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user" && msg.metadata?.synthetic !== true) {
      targetIndex = i;
      break;
    }
  }

  if (targetIndex === -1) {
    return messages;
  }

  const resolved = await resolveIncludeFiles(options.runtime, options.workspacePath, patterns, {
    abortSignal: options.abortSignal,
    listMode: "git",
  });

  const rendered = renderIncludedFilesContext(resolved).trim();
  if (!rendered) {
    return messages;
  }

  const injected = createMuxMessage(`agent-include-files-${Date.now()}`, "user", rendered, {
    timestamp: Date.now(),
    synthetic: true,
  });

  const result = [...messages];
  result.splice(targetIndex, 0, injected);
  return result;
}
