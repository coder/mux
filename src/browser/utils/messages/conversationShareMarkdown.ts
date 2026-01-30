import type { MuxMessage } from "@/common/types/message";

const MAX_TOOL_BLOCK_CHARS = 20_000;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  return {
    text: text.slice(0, maxChars) + `\n…(truncated; ${text.length - maxChars} chars omitted)`,
    truncated: true,
  };
}

function getMessageTimestamp(message: MuxMessage): number | null {
  const metaTs = message.metadata?.timestamp;
  if (typeof metaTs === "number" && Number.isFinite(metaTs)) {
    return metaTs;
  }

  // Fall back to the latest part timestamp.
  let max: number | null = null;
  for (const part of message.parts) {
    const ts = "timestamp" in part ? part.timestamp : undefined;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      max = max === null ? ts : Math.max(max, ts);
    }
  }
  return max;
}

function getConversationUpdatedAt(
  muxMessages: MuxMessage[],
  includeSynthetic: boolean
): number | null {
  let max: number | null = null;

  for (const message of muxMessages) {
    if (!includeSynthetic && message.metadata?.synthetic === true) {
      continue;
    }

    const ts = getMessageTimestamp(message);
    if (ts === null) continue;
    max = max === null ? ts : Math.max(max, ts);
  }

  return max;
}

function buildCodeBlock(options: { language: string; content: string }): string {
  // Keep triple-backticks out of the content to avoid breaking the transcript structure.
  // This is a best-effort escape and should not be considered a security boundary.
  const safeContent = options.content.replaceAll("```", "\\`\\`\\`");
  return `\n\`\`\`${options.language}\n${safeContent}\n\`\`\`\n`;
}

function buildToolBlock(options: {
  toolName: string;
  state: "input-available" | "output-available";
  input: unknown;
  output?: unknown;
}): string {
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>Tool: ${options.toolName} (${options.state})</summary>`);
  lines.push("");

  lines.push("**Input**");
  lines.push(
    buildCodeBlock({ language: "json", content: safeJsonStringify(options.input) }).trimEnd()
  );

  if (options.state === "output-available") {
    lines.push("");
    lines.push("**Output**");

    const outputContent =
      typeof options.output === "string" ? options.output : safeJsonStringify(options.output);
    const { text } = truncateText(outputContent, MAX_TOOL_BLOCK_CHARS);
    lines.push(
      buildCodeBlock({
        language: typeof options.output === "string" ? "text" : "json",
        content: text,
      }).trimEnd()
    );
  }

  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function buildFilePlaceholder(options: { filename?: string; mediaType: string }): string {
  const name = options.filename ?? "(unnamed file)";
  return `_[file: ${name} (${options.mediaType})]_`;
}

export function buildConversationShareMarkdown(options: {
  muxMessages: MuxMessage[];
  workspaceName: string;
  includeSynthetic?: boolean;
}): string {
  const includeSynthetic = options.includeSynthetic ?? false;
  const title =
    options.workspaceName.trim().length > 0 ? options.workspaceName.trim() : "Conversation";

  const lines: string[] = [];
  lines.push(`# ${title}`);

  // NOTE: This must be deterministic for a given conversation so we can re-use cached mux.md
  // shares (the cache key is the transcript content). Avoid Date.now() here.
  const updatedAt = getConversationUpdatedAt(options.muxMessages, includeSynthetic);
  if (updatedAt !== null) {
    lines.push(`Shared from Mux · Last updated ${new Date(updatedAt).toISOString()}`);
  } else {
    lines.push("Shared from Mux");
  }

  for (const message of options.muxMessages) {
    if (!includeSynthetic && message.metadata?.synthetic === true) {
      continue;
    }

    // MuxMessage supports system messages, but they aren't part of the user-visible transcript
    // in Mux today. If we ever persist system messages, we can revisit this.
    if (message.role === "system") {
      continue;
    }

    const roleLabel = message.role === "user" ? "User" : "Assistant";

    lines.push("---");
    lines.push(`## ${roleLabel}`);

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text.trim().length > 0) {
          lines.push(part.text.trimEnd());
        }
        continue;
      }

      if (part.type === "reasoning") {
        if (part.text.trim().length === 0) {
          continue;
        }

        lines.push(
          [
            "<details>",
            "<summary>Reasoning</summary>",
            "",
            part.text.trimEnd(),
            "",
            "</details>",
          ].join("\n")
        );
        continue;
      }

      if (part.type === "file") {
        lines.push(buildFilePlaceholder({ filename: part.filename, mediaType: part.mediaType }));
        continue;
      }

      if (part.type === "dynamic-tool") {
        lines.push(
          buildToolBlock({
            toolName: part.toolName,
            state: part.state,
            input: part.input,
            output: "output" in part ? part.output : undefined,
          })
        );
        continue;
      }
    }
  }

  return lines.join("\n\n").trimEnd() + "\n";
}
