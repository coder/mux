import { MCP_TOOL_RESULT_MAX_TEXT_BYTES } from "@/common/constants/toolLimits";
import { log } from "@/node/services/log";

/**
 * Maximum size of base64 image data in bytes before we drop it.
 *
 * Rationale: providers already accept multi‑megabyte images, but a single
 * 20–30MB screenshot can still blow up request sizes or hit provider limits
 * (e.g., Anthropic ~32MB total request). We keep a generous per‑image guard to
 * pass normal screenshots while preventing pathological payloads.
 */
export const MAX_IMAGE_DATA_BYTES = 8 * 1024 * 1024; // 8MB guard per image

/**
 * MCP CallToolResult content types (MCP spec wire shapes)
 */
interface MCPTextContent {
  type: "text";
  text: string;
}

interface MCPImageContent {
  type: "image";
  data: string; // base64
  mimeType: string;
}

interface MCPAudioContent {
  type: "audio";
  data: string; // base64
  mimeType: string;
}

interface MCPResourceContent {
  type: "resource";
  resource: { uri: string; text?: string; blob?: string; mimeType?: string };
}

type MCPContent = MCPTextContent | MCPImageContent | MCPAudioContent | MCPResourceContent;

export interface MCPCallToolResult {
  content?: MCPContent[];
  isError?: boolean;
  toolResult?: unknown;
  structuredContent?: unknown;
}

/**
 * AI SDK LanguageModelV2ToolResultOutput content types
 */
type AISDKContentPart =
  | { type: "text"; text: string }
  | { type: "media"; data: string; mediaType: string };

/**
 * Format byte size as human-readable string (KB or MB).
 * Uses decimal (SI) units (1000-based) — intentionally different from the shared
 * binary-unit formatBytes in @/common/utils/formatBytes which uses 1024-based thresholds.
 */
function formatBytesSI(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

// Enforce byte budgets on UTF-8 bytes; non-ASCII text can use up to three
// bytes per UTF-16 code unit. Backs up to a UTF-8 sequence boundary before
// decoding.
export function truncateUtf8Bytes(text: string, maxBytes: number, marker: string): string {
  // Encoding at most maxBytes UTF-16 code units bounds the temporary buffer
  // while still covering maxBytes UTF-8 bytes.
  const prefix = text.length > maxBytes ? text.slice(0, maxBytes) : text;
  const bytes = Buffer.from(prefix, "utf8");
  if (prefix === text && bytes.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end--;
  }
  return bytes.subarray(0, end).toString("utf8") + marker;
}

/**
 * Shared text budget threaded through one result so many text parts cannot
 * multiply the cap.
 */
interface TextBudget {
  remaining: number;
}

function textTruncationNotice(byteLength: number): string {
  return `[MCP tool result text truncated: ${formatBytesSI(byteLength)} exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} cap. Narrow the query to reduce output size.]`;
}

/**
 * Charge `text` against the budget. Returns the (possibly truncated) text, or
 * null when the budget is already exhausted and the part should be dropped.
 */
function capText(text: string, budget: TextBudget): { text: string; truncated: boolean } | null {
  const size = Buffer.byteLength(text, "utf8");
  if (size <= budget.remaining) {
    budget.remaining -= size;
    return { text, truncated: false };
  }
  if (budget.remaining <= 0) {
    return null;
  }
  const kept = truncateUtf8Bytes(text, budget.remaining, "");
  budget.remaining = 0;
  return { text: `${kept}\n\n${textTruncationNotice(size)}`, truncated: true };
}

function omittedPartsNotice(count: number): string {
  return `[${count} content part(s) omitted: MCP tool result exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} text cap]`;
}

function omittedValueNotice(kind: string, byteLength: number): string {
  return `[MCP ${kind} omitted: ${formatBytesSI(byteLength)} exceeds the ${formatBytesSI(MCP_TOOL_RESULT_MAX_TEXT_BYTES)} cap. Narrow the query to reduce output size.]`;
}

function jsonByteLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    // Unserializable results (circular refs, BigInt) cannot be persisted to
    // chat.jsonl anyway; treat them as oversized so they become a bounded notice.
    return Number.POSITIVE_INFINITY;
  }
}

/** Binary media guard shared by image/audio content and blob resources. */
function toGuardedMediaPart(
  kind: string,
  data: string | undefined,
  mediaType: string
): AISDKContentPart {
  const dataLength = data?.length ?? 0;
  if (dataLength > MAX_IMAGE_DATA_BYTES) {
    log.warn(`[MCP] ${kind} data too large, omitting from context`, {
      mediaType,
      dataLength,
      maxAllowed: MAX_IMAGE_DATA_BYTES,
    });
    return {
      type: "text",
      text: `[${kind} omitted: ${formatBytesSI(dataLength)} exceeds per-${kind.toLowerCase()} guard of ${formatBytesSI(MAX_IMAGE_DATA_BYTES)}. Reduce resolution or quality and retry.]`,
    };
  }
  return { type: "media", data: data ?? "", mediaType };
}

/**
 * Transform MCP tool result to AI SDK format.
 * Converts MCP binary content (image, audio, embedded blob resources) to AI
 * SDK "media" parts — the single conversion layer for MCP media (mixed
 * text+binary results included). Truncates large payloads to prevent context
 * overflow.
 */
export function transformMCPResult(result: unknown): unknown {
  // Primitive string results skip the content-array capping below, so bound
  // them directly.
  if (typeof result === "string") {
    const size = Buffer.byteLength(result, "utf8");
    if (size <= MCP_TOOL_RESULT_MAX_TEXT_BYTES) {
      return result;
    }
    log.warn("[MCP] string tool result too large, truncating", {
      size,
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return truncateUtf8Bytes(
      result,
      MCP_TOOL_RESULT_MAX_TEXT_BYTES,
      `\n\n${textTruncationNotice(size)}`
    );
  }

  if (!result || typeof result !== "object") {
    return result;
  }

  const typed = result as MCPCallToolResult;

  // If it has toolResult (non-standard result shape), pass through as-is when
  // it fits the cap; otherwise replace it with a bounded notice.
  if (typed.toolResult !== undefined) {
    const size = jsonByteLength(result);
    if (size <= MCP_TOOL_RESULT_MAX_TEXT_BYTES) {
      return result;
    }
    log.warn("[MCP] toolResult too large, omitting", {
      size,
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return { toolResult: omittedValueNotice("toolResult", size) };
  }

  // If no content array, pass through when it fits the cap; otherwise replace
  // with a bounded notice in MCP text shape so toModelOutput surfaces it.
  if (!typed.content || !Array.isArray(typed.content)) {
    const size = jsonByteLength(result);
    if (size <= MCP_TOOL_RESULT_MAX_TEXT_BYTES) {
      return result;
    }
    log.warn("[MCP] tool result too large, omitting", {
      size,
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    });
    return { content: [{ type: "text", text: omittedValueNotice("tool result", size) }] };
  }

  // Only rewrite results carrying binary payloads; text-only results
  // (including text-only errors) stay in MCP shape (converted by the tool's
  // toModelOutput, which keeps the isError flag visible to the model), with
  // oversized text capped in place.
  const hasBinaryContent = typed.content.some(
    (c) =>
      c.type === "image" ||
      c.type === "audio" ||
      (c.type === "resource" && typeof c.resource?.blob === "string")
  );
  if (!hasBinaryContent) {
    return capTextOnlyResult(typed);
  }

  // Debug: log what we received from MCP
  log.debug("[MCP] transformMCPResult input", {
    contentTypes: typed.content.map((c) => c.type),
  });

  // Transform to AI SDK content format
  const budget: TextBudget = { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES };
  let omitted = 0;
  let truncated = false;
  const transformedContent: AISDKContentPart[] = [];
  const pushCappedText = (text: string): void => {
    const capped = capText(text, budget);
    if (capped === null) {
      omitted += 1;
      return;
    }
    truncated ||= capped.truncated;
    transformedContent.push({ type: "text", text: capped.text });
  };
  for (const item of typed.content) {
    if (item.type === "text") {
      pushCappedText(item.text);
    } else if (item.type === "image") {
      // Ensure mediaType is present - default to image/png if missing
      transformedContent.push(toGuardedMediaPart("Image", item.data, item.mimeType || "image/png"));
    } else if (item.type === "audio") {
      transformedContent.push(toGuardedMediaPart("Audio", item.data, item.mimeType || "audio/wav"));
    } else if (item.type === "resource") {
      if (typeof item.resource.blob === "string") {
        transformedContent.push(
          toGuardedMediaPart(
            "Resource",
            item.resource.blob,
            item.resource.mimeType ?? "application/octet-stream"
          )
        );
      } else {
        // Text resources: surface the text (or the URI as a reference).
        pushCappedText(item.resource.text ?? item.resource.uri);
      }
    } else {
      // Fallback: stringify unknown content
      pushCappedText(JSON.stringify(item));
    }
  }
  if (omitted > 0) {
    transformedContent.push({ type: "text", text: omittedPartsNotice(omitted) });
  }
  if (truncated || omitted > 0) {
    log.warn("[MCP] tool result text exceeded cap, truncated", {
      cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
      omittedParts: omitted,
    });
  }

  // The model-output "content" shape has no error flag, so error results
  // carrying binary payloads get an explicit text marker instead of bypassing
  // the media conversion (and its size guard).
  if (typed.isError) {
    transformedContent.unshift({ type: "text", text: "[Tool reported an error]" });
  }

  return { type: "content", value: transformedContent };
}

/**
 * Cap the text surfaces of a text-only MCP result while preserving its wire
 * shape (content array + isError). Returns the original object when nothing
 * exceeds the cap.
 */
function capTextOnlyResult(typed: MCPCallToolResult): unknown {
  const budget: TextBudget = { remaining: MCP_TOOL_RESULT_MAX_TEXT_BYTES };
  let changed = false;
  let omitted = 0;
  const cappedContent: MCPContent[] = [];

  for (const item of typed.content ?? []) {
    if (item.type === "text") {
      const capped = capText(item.text, budget);
      if (capped === null) {
        omitted += 1;
        continue;
      }
      changed ||= capped.truncated;
      cappedContent.push(capped.truncated ? { ...item, text: capped.text } : item);
      continue;
    }
    if (item.type === "resource" && typeof item.resource?.text === "string") {
      const capped = capText(item.resource.text, budget);
      if (capped === null) {
        omitted += 1;
        continue;
      }
      changed ||= capped.truncated;
      cappedContent.push(
        capped.truncated ? { ...item, resource: { ...item.resource, text: capped.text } } : item
      );
      continue;
    }
    cappedContent.push(item);
  }

  if (omitted > 0) {
    changed = true;
    cappedContent.push({ type: "text", text: omittedPartsNotice(omitted) });
  }

  // structuredContent duplicates the content text as JSON and is invisible to
  // the model (toModelOutput only reads content), so drop it wholesale when
  // oversized instead of truncating JSON mid-structure.
  const structuredSize =
    typed.structuredContent !== undefined ? jsonByteLength(typed.structuredContent) : 0;
  const dropStructured = structuredSize > MCP_TOOL_RESULT_MAX_TEXT_BYTES;
  if (dropStructured) {
    changed = true;
    cappedContent.push({
      type: "text",
      text: omittedValueNotice("structuredContent", structuredSize),
    });
  }

  if (!changed) {
    return typed;
  }

  log.warn("[MCP] tool result text exceeded cap, truncated", {
    cap: MCP_TOOL_RESULT_MAX_TEXT_BYTES,
    omittedParts: omitted,
    structuredContentDropped: dropStructured,
  });

  const capped: MCPCallToolResult = { ...typed, content: cappedContent };
  if (dropStructured) {
    delete capped.structuredContent;
  }
  return capped;
}
