import type { ConvoSummary, LocSummary } from "@/common/lib/muxMd";
import type { MuxMessage } from "@/common/types/message";
import { getToolOutputUiOnly } from "@/common/utils/tools/toolOutputUiOnly";

const MAX_TOOL_BLOCK_CHARS = 20_000;

const FILE_EDIT_TOOL_NAMES = new Set([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getFilePathFromToolInput(input: unknown): string | null {
  return isRecord(input) && typeof input.file_path === "string" ? input.file_path : null;
}

function getFileEditDiff(output: unknown): string | null {
  const uiOnlyDiff = getToolOutputUiOnly(output)?.file_edit?.diff;
  if (uiOnlyDiff && uiOnlyDiff.trim().length > 0) {
    return uiOnlyDiff;
  }

  if (isRecord(output) && typeof output.diff === "string") {
    return output.diff;
  }

  return null;
}

function getDiffLocSummary(diff: string): LocSummary {
  let added = 0;
  let removed = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("---")) continue;

    if (line.startsWith("+")) {
      added++;
      continue;
    }

    if (line.startsWith("-")) {
      removed++;
    }
  }

  return { added, removed };
}

export function buildConversationShareConvoSummary(options: {
  muxMessages: MuxMessage[];
  includeSynthetic?: boolean;
  repo?: string;
}): ConvoSummary {
  const includeSynthetic = options.includeSynthetic ?? false;

  let userPromptCount = 0;
  const filesModified = new Set<string>();
  let locAdded = 0;
  let locRemoved = 0;

  for (const message of options.muxMessages) {
    if (!includeSynthetic && message.metadata?.synthetic === true) {
      continue;
    }

    if (message.role === "user") {
      userPromptCount++;
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") {
        continue;
      }

      if (!FILE_EDIT_TOOL_NAMES.has(part.toolName)) {
        continue;
      }

      if (part.state !== "output-available" || !("output" in part)) {
        continue;
      }

      const output = part.output;
      if (!isRecord(output) || output.success !== true) {
        continue;
      }

      const filePath = getFilePathFromToolInput(part.input);
      if (filePath) {
        filesModified.add(filePath);
      }

      const diff = getFileEditDiff(output);
      if (diff) {
        const loc = getDiffLocSummary(diff);
        locAdded += loc.added;
        locRemoved += loc.removed;
      }
    }
  }

  return {
    repo: options.repo,
    clientMode: "desktop",
    userPromptCount: userPromptCount > 0 ? userPromptCount : undefined,
    filesModifiedCount: filesModified.size > 0 ? filesModified.size : undefined,
    loc:
      locAdded > 0 || locRemoved > 0
        ? {
            added: locAdded,
            removed: locRemoved,
          }
        : undefined,
  };
}

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
  preview?: { label: string; language: string; content: string };
}): string {
  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>Tool: ${options.toolName} (${options.state})</summary>`);
  lines.push("");

  lines.push("**Input**");
  lines.push(
    buildCodeBlock({ language: "json", content: safeJsonStringify(options.input) }).trimEnd()
  );

  if (options.preview) {
    lines.push("");
    lines.push(`**${options.preview.label}**`);

    const { text } = truncateText(options.preview.content, MAX_TOOL_BLOCK_CHARS);
    lines.push(buildCodeBlock({ language: options.preview.language, content: text }).trimEnd());
  }

  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

function buildFilePlaceholder(options: { filename?: string; mediaType: string }): string {
  const name = options.filename ?? "(unnamed file)";
  return `[file: ${name} (${options.mediaType})]`;
}

function escapeHtml(text: string): string {
  // We embed user text into raw HTML (inside a <pre>), so it must be escaped.
  // This is a best-effort escape and should not be considered a security boundary.
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function formatMessageTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildUserMessageBubble(options: { content: string; timestampMs: number | null }): string {
  const lines: string[] = [];
  lines.push('<div data-message-block class="ml-auto w-fit">');
  lines.push("  <div>");
  lines.push(`    <div data-message-content><pre>${escapeHtml(options.content)}</pre></div>`);
  lines.push("  </div>");

  if (options.timestampMs !== null) {
    lines.push(
      `  <div data-message-meta><span data-message-timestamp>${escapeHtml(
        formatMessageTimestamp(options.timestampMs)
      )}</span></div>`
    );
  }

  lines.push("</div>");
  return lines.join("\n");
}

function buildReasoningBlock(content: string): string | null {
  const trimmedEnd = content.trimEnd();
  const trimmed = trimmedEnd.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const summaryLine = (trimmed.split(/\r?\n/)[0] ?? "").trim();
  const hasAdditionalLines = /[\r\n]/.test(trimmed);
  const summary = hasAdditionalLines ? `${summaryLine} ...` : summaryLine;

  const { text } = truncateText(trimmedEnd, MAX_TOOL_BLOCK_CHARS);

  const lines: string[] = [];
  lines.push("<details>");
  lines.push(`<summary>${escapeHtml(summary)}</summary>`);
  lines.push("");
  lines.push(text.trimEnd());
  lines.push("");
  lines.push("</details>");

  return lines.join("\n");
}

export function buildConversationShareMarkdown(options: {
  muxMessages: MuxMessage[];
  workspaceName: string;
  includeSynthetic?: boolean;
}): string {
  const includeSynthetic = options.includeSynthetic ?? false;
  const title =
    options.workspaceName.trim().length > 0 ? options.workspaceName.trim() : "Conversation";

  const blocks: string[] = [];

  // NOTE: This must be deterministic for a given conversation so we can re-use cached mux.md
  // shares (the cache key is the transcript content). Avoid Date.now() here.
  const updatedAt = getConversationUpdatedAt(options.muxMessages, includeSynthetic);
  const headerLine =
    updatedAt !== null
      ? `Shared from Mux · Last updated ${new Date(updatedAt).toISOString()}`
      : "Shared from Mux";
  blocks.push([`# ${title}`, headerLine].join("\n"));

  for (const message of options.muxMessages) {
    if (!includeSynthetic && message.metadata?.synthetic === true) {
      continue;
    }

    // MuxMessage supports system messages, but they aren't part of the user-visible transcript
    // in Mux today. If we ever persist system messages, we can revisit this.
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      // mux.md renders user messages as chat bubbles when wrapped in this structure.
      // Keep user content in <pre> to preserve whitespace and avoid markdown parsing.
      const bubbleLines: string[] = [];
      let pendingText = "";
      const flushPendingText = () => {
        if (pendingText.length === 0) return;
        bubbleLines.push(pendingText);
        pendingText = "";
      };

      for (const part of message.parts) {
        if (part.type === "text") {
          pendingText += part.text;
          continue;
        }

        if (part.type === "file") {
          flushPendingText();
          bubbleLines.push(
            buildFilePlaceholder({ filename: part.filename, mediaType: part.mediaType })
          );
          continue;
        }

        // Reasoning blocks are intentionally omitted from shared transcripts.
        // Tool parts are unexpected for user messages; omit rather than bloating the transcript.
      }

      flushPendingText();

      blocks.push(
        buildUserMessageBubble({
          content: bubbleLines.join("\n").trimEnd(),
          timestampMs: getMessageTimestamp(message),
        })
      );
      continue;
    }

    // Assistant message: render as normal markdown (mux.md handles it naturally).
    const assistantBlocks: string[] = [];

    // NOTE: Real MuxMessage history often contains many sequential "text" parts (streaming deltas).
    // We want to preserve the exact text without inserting extra whitespace between chunks.
    let pendingText = "";
    const flushPendingText = () => {
      if (pendingText.trim().length === 0) {
        pendingText = "";
        return;
      }

      assistantBlocks.push(pendingText.trimEnd());
      pendingText = "";
    };

    for (const part of message.parts) {
      if (part.type === "text") {
        pendingText += part.text;
        continue;
      }

      if (part.type === "reasoning") {
        flushPendingText();
        const reasoningBlock = buildReasoningBlock(part.text);
        if (reasoningBlock) {
          assistantBlocks.push(reasoningBlock);
        }
        continue;
      }

      if (part.type === "file") {
        flushPendingText();
        assistantBlocks.push(
          buildFilePlaceholder({ filename: part.filename, mediaType: part.mediaType })
        );
        continue;
      }

      if (part.type === "dynamic-tool") {
        flushPendingText();

        let preview: { label: string; language: string; content: string } | undefined;
        if (
          FILE_EDIT_TOOL_NAMES.has(part.toolName) &&
          part.state === "output-available" &&
          "output" in part
        ) {
          const output = part.output;
          if (isRecord(output) && output.success === true) {
            const diff = getFileEditDiff(output);
            if (diff) {
              preview = { label: "Preview", language: "diff", content: diff };
            }
          }
        }

        assistantBlocks.push(
          buildToolBlock({
            toolName: part.toolName,
            state: part.state,
            input: part.input,
            preview,
          })
        );
        continue;
      }
    }

    flushPendingText();

    const assistantContent = assistantBlocks.join("\n\n").trimEnd();
    if (assistantContent.trim().length > 0) {
      blocks.push(assistantContent);
    }
  }

  return blocks.join("\n\n").trimEnd() + "\n";
}
