import type { DisplayedMessage } from "@/common/types/message";
import { extractToolFilePath } from "@/common/utils/tools/toolInputFilePath";

/**
 * Tool coalescing groups consecutive tool calls of related kinds into a single
 * "summary" row that takes the place of the head call. The follow-up calls are
 * hidden from the transcript until the user expands the group.
 *
 * Why: when an agent reads or writes a burst of files, each individual row
 * pushes more useful content (assistant prose, terminal output, etc.) off
 * screen. Coalescing keeps those bursts skimmable while still allowing the
 * user to drill into any individual tool call.
 *
 * Why the head-replacement design: the coalesce row reuses the head's slot in
 * the transcript so the 1 -> N transition is a content swap rather than a
 * row insertion. The summary row is sized to match a collapsed single-file
 * tool call so the user does not see a layout flash when the second member
 * arrives mid-stream.
 */

/**
 * Kinds of tool calls that can be coalesced.
 *
 * Both Anthropic-flavored and historical `file_edit_*` variants are grouped
 * under a single "file_edit" kind so a mixed run of inserts/replaces still
 * forms one logical "Wrote files …" block in the transcript.
 */
export type ToolCoalesceKind = "file_read" | "file_edit";

const FILE_READ_TOOL_NAMES = new Set<string>(["file_read"]);

// All current and legacy file-edit variants. `file_edit_replace_lines` is no
// longer wired into the live tool registry, but historical transcripts may
// still contain it, so we include it here to keep older sessions consistent.
const FILE_EDIT_TOOL_NAMES = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

/** Minimum group size before we coalesce. Below this we just render normally. */
const MIN_COALESCE_GROUP_SIZE = 2;

/**
 * Information about a tool message's position within a coalesced group.
 * Aligned with the messages array passed to {@link computeToolCoalesceInfos}.
 */
export interface ToolCoalesceInfo {
  /** Which kind of tool group this message belongs to. */
  kind: ToolCoalesceKind;
  /**
   * "head" — the first call in the group. Rendered as the coalesce summary
   * row when collapsed; rendered both as the summary row and normally when
   * expanded.
   *
   * "member" — every other call in the group. Hidden when collapsed; rendered
   * normally when expanded.
   */
  position: "head" | "member";
  /** Total number of tool calls coalesced into this group (>= 2). */
  totalCount: number;
  /** Index of the head message; used as the expansion-state key. */
  headIndex: number;
  /**
   * File paths involved in the group, in chronological order. Used by the
   * head's summary row to render "Read files a, b, c". May contain duplicates
   * if the same file appears in multiple consecutive calls.
   */
  filePaths: string[];
}

function getCoalesceKind(msg: DisplayedMessage | undefined): ToolCoalesceKind | undefined {
  if (msg?.type !== "tool") return undefined;
  if (FILE_READ_TOOL_NAMES.has(msg.toolName)) return "file_read";
  if (FILE_EDIT_TOOL_NAMES.has(msg.toolName)) return "file_edit";
  return undefined;
}

/**
 * A coalesceable member is a tool call whose row carries no actionable
 * signal the user would lose if hidden. Individual tool rows surface
 * status (pending/executing/failed/interrupted/redacted) and inline
 * errors, and partial rows render an InterruptedBarrier. The summary
 * row deliberately renders none of those, so any non-completed or
 * partial member forces the whole group back to normal rendering.
 */
function isCoalesceableToolMember(msg: DisplayedMessage | undefined): boolean {
  if (msg?.type !== "tool") return false;
  if (msg.isPartial) return false;
  return msg.status === "completed";
}

/**
 * Compute coalesce metadata for every message in one linear pass.
 *
 * Returns an array aligned with `messages` where each entry is either a
 * {@link ToolCoalesceInfo} (this message participates in a group) or
 * `undefined` (rendered normally).
 *
 * Performance: workspace-open commits the full history in one pass; we keep
 * this O(n) so the coalescing work scales with transcript size.
 */
export function computeToolCoalesceInfos(
  messages: DisplayedMessage[]
): Array<ToolCoalesceInfo | undefined> {
  const infos = new Array<ToolCoalesceInfo | undefined>(messages.length);

  let index = 0;
  while (index < messages.length) {
    const kind = getCoalesceKind(messages[index]);
    if (!kind) {
      index++;
      continue;
    }

    // Walk forward while the next message has the same coalesce kind.
    let groupEnd = index;
    while (groupEnd < messages.length - 1 && getCoalesceKind(messages[groupEnd + 1]) === kind) {
      groupEnd++;
    }

    const groupSize = groupEnd - index + 1;

    // Skip coalescing if any member is not safely coalesceable (still
    // running, failed, interrupted, redacted, or partial). Those rows
    // carry status/error UI or an InterruptedBarrier that the summary
    // row deliberately does not render, so hiding them would eat the
    // signal until the user manually expands the group.
    let allMembersCoalesceable = true;
    for (let j = index; j <= groupEnd; j++) {
      if (!isCoalesceableToolMember(messages[j])) {
        allMembersCoalesceable = false;
        break;
      }
    }

    if (groupSize >= MIN_COALESCE_GROUP_SIZE && allMembersCoalesceable) {
      const filePaths: string[] = [];
      for (let j = index; j <= groupEnd; j++) {
        const candidate = messages[j];
        // Guarded by the walk above, but narrow defensively for TypeScript.
        if (candidate?.type !== "tool") continue;
        filePaths.push(extractToolFilePath(candidate.args) ?? "(unknown)");
      }

      for (let j = index; j <= groupEnd; j++) {
        infos[j] = {
          kind,
          position: j === index ? "head" : "member",
          totalCount: groupSize,
          headIndex: index,
          filePaths,
        };
      }
    }

    index = groupEnd + 1;
  }

  return infos;
}
