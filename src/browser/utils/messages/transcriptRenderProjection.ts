import type { DisplayedMessage } from "@/common/types/message";
import { isPlainObject } from "@/common/utils/isPlainObject";

export type OperationalBundleMemberMessage = DisplayedMessage & { type: "reasoning" | "tool" };

export interface OperationalBundleSummary {
  title: string;
  details: string;
}

export interface OperationalBundleEntry {
  message: OperationalBundleMemberMessage;
  originalIndex: number;
}

export interface OperationalBundleInfo {
  key: string;
  position: "head" | "member";
  /** Render slot where the bundle header is placed; leading entries can appear earlier. */
  headIndex: number;
  entries: readonly OperationalBundleEntry[];
  summary: OperationalBundleSummary;
  state: "active" | "settled";
  defaultExpanded: boolean;
}

export interface WorkBundleEntry {
  message: DisplayedMessage;
  originalIndex: number;
}

export interface WorkBundleInfo {
  key: string;
  position: "head" | "member" | "final";
  /** Render slot where the work-bundle header is placed. */
  headIndex: number;
  entries: readonly WorkBundleEntry[];
  durationMs?: number;
  defaultExpanded: boolean;
}

interface ComputeBundleInfosOptions {
  isTurnActive: boolean;
}

type OperationalBundleCategory =
  | "edit"
  | "fetch"
  | "question"
  | "read"
  | "reasoning"
  | "search"
  | "shell"
  | "skill"
  | "task"
  | "tool";

const FILE_READ_TOOL_NAMES = new Set<string>(["file_read"]);

// Keep legacy edit tool names categorized as edits for old transcripts, without
// reintroducing the removed file-tool coalescing render path.
const FILE_EDIT_TOOL_NAMES = new Set<string>([
  "file_edit_replace_string",
  "file_edit_replace_lines",
  "file_edit_insert",
]);

const OPERATIONAL_BUNDLE_CATEGORY_COPY: Record<
  OperationalBundleCategory,
  { singletonTitle: string; detailLabel: string; detailLabelPlural: string }
> = {
  reasoning: {
    singletonTitle: "Reasoned",
    detailLabel: "reasoning step",
    detailLabelPlural: "reasoning steps",
  },
  read: { singletonTitle: "Read 1 file", detailLabel: "read", detailLabelPlural: "reads" },
  search: {
    singletonTitle: "Searched 1 query",
    detailLabel: "search",
    detailLabelPlural: "searches",
  },
  fetch: { singletonTitle: "Fetched 1 page", detailLabel: "fetch", detailLabelPlural: "fetches" },
  skill: {
    singletonTitle: "Read 1 skill",
    detailLabel: "skill read",
    detailLabelPlural: "skill reads",
  },
  edit: { singletonTitle: "Edited 1 file", detailLabel: "edit", detailLabelPlural: "edits" },
  shell: {
    singletonTitle: "Ran 1 shell command",
    detailLabel: "shell command",
    detailLabelPlural: "shell commands",
  },
  question: {
    singletonTitle: "Asked 1 question",
    detailLabel: "question",
    detailLabelPlural: "questions",
  },
  task: {
    singletonTitle: "Ran 1 agent task",
    detailLabel: "agent task",
    detailLabelPlural: "agent tasks",
  },
  tool: {
    singletonTitle: "Ran 1 operation",
    detailLabel: "operation",
    detailLabelPlural: "operations",
  },
};

export function computeWorkBundleInfos(
  messages: DisplayedMessage[]
): Array<WorkBundleInfo | undefined> {
  const infos = new Array<WorkBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const historyId = getWorkBundleHistoryId(messages[index]);
    if (historyId === undefined) {
      index += 1;
      continue;
    }

    const startIndex = index;
    while (getWorkBundleHistoryId(messages[index + 1]) === historyId) {
      index += 1;
    }

    const finalIndex = index;
    index += 1;

    if (finalIndex <= startIndex) {
      continue;
    }

    if (messages[finalIndex]?.type !== "assistant") {
      continue;
    }

    const entries: WorkBundleEntry[] = [];
    for (let entryIndex = startIndex; entryIndex < finalIndex; entryIndex++) {
      entries.push({ message: messages[entryIndex], originalIndex: entryIndex });
    }

    const groupMessages = [...entries.map((entry) => entry.message), messages[finalIndex]];
    if (groupMessages.some(isActiveWorkBundleMessage)) {
      continue;
    }

    const frozenEntries = Object.freeze(entries);
    const first = entries[0].message;
    const info: WorkBundleInfo = {
      key: `work:${first.id}`,
      position: "head",
      headIndex: startIndex,
      entries: frozenEntries,
      durationMs: computeWorkBundleDurationMs(frozenEntries, messages[finalIndex]),
      defaultExpanded: false,
    };

    for (const entry of entries) {
      infos[entry.originalIndex] = {
        ...info,
        position: entry.originalIndex === startIndex ? "head" : "member",
      };
    }
    infos[finalIndex] = { ...info, position: "final" };
  }

  return infos;
}

export function computeOperationalBundleInfos(
  messages: DisplayedMessage[],
  options: ComputeBundleInfosOptions
): Array<OperationalBundleInfo | undefined> {
  const infos = new Array<OperationalBundleInfo | undefined>(messages.length);
  let index = 0;

  while (index < messages.length) {
    const leadingReasoningStart = index;
    const leadingReasoningEntries: OperationalBundleEntry[] = [];
    while (true) {
      const message = messages[index];
      if (message?.type !== "reasoning") {
        break;
      }
      leadingReasoningEntries.push({ message, originalIndex: index });
      index += 1;
    }

    if (leadingReasoningEntries.length > 0 && messages[index]?.type === "assistant") {
      index += 1;
    } else if (leadingReasoningEntries.length > 0) {
      leadingReasoningEntries.length = 0;
      index = leadingReasoningStart;
    }

    if (!isOperationalBundleMemberMessage(messages[index])) {
      index += 1;
      continue;
    }

    const headIndex = index;
    const entries: OperationalBundleEntry[] = [...leadingReasoningEntries];
    while (index < messages.length) {
      const candidate = messages[index];
      if (!isOperationalBundleMemberMessage(candidate)) {
        break;
      }
      entries.push({ message: candidate, originalIndex: index });
      index += 1;
    }

    const frozenEntries = Object.freeze(entries);
    const first = entries[0].message;

    const state = frozenEntries.some((entry) => isActiveOperationalMessage(entry.message))
      ? "active"
      : "settled";
    const hasSubsequentVisibleEvent = hasVisibleEventAfter(messages, index);
    const defaultExpanded =
      state === "active" || (options.isTurnActive && !hasSubsequentVisibleEvent);
    const key = `bundle:${first.id}`;
    const summary = summarizeOperationalBundle(frozenEntries.map((entry) => entry.message));

    for (const entry of frozenEntries) {
      infos[entry.originalIndex] = {
        key,
        position: entry.originalIndex === headIndex ? "head" : "member",
        headIndex,
        entries: frozenEntries,
        summary,
        state,
        defaultExpanded,
      };
    }
  }

  return infos;
}

function getWorkBundleHistoryId(message: DisplayedMessage | undefined): string | undefined {
  switch (message?.type) {
    case "assistant":
    case "reasoning":
      return message.historyId;
    case "tool":
      return isBundleableToolMessage(message) ? message.historyId : undefined;
    default:
      return undefined;
  }
}

function isActiveWorkBundleMessage(message: DisplayedMessage): boolean {
  if (message.type === "assistant" || message.type === "reasoning") {
    return message.isStreaming;
  }
  return (
    message.type === "tool" && (message.status === "pending" || message.status === "executing")
  );
}

function getMessageTimestamp(message: DisplayedMessage): number | undefined {
  return "timestamp" in message && typeof message.timestamp === "number"
    ? message.timestamp
    : undefined;
}

function computeWorkBundleDurationMs(
  entries: readonly WorkBundleEntry[],
  finalMessage: DisplayedMessage
): number | undefined {
  const startTimestamp = getMessageTimestamp(entries[0].message);
  const endTimestamp =
    getMessageTimestamp(finalMessage) ?? getMessageTimestamp(entries.at(-1)!.message);
  if (
    startTimestamp === undefined ||
    endTimestamp === undefined ||
    endTimestamp <= startTimestamp
  ) {
    return undefined;
  }
  return endTimestamp - startTimestamp;
}

function hasVisibleEventAfter(messages: DisplayedMessage[], startIndex: number): boolean {
  for (let index = startIndex; index < messages.length; index++) {
    if (!isOperationalBundleMemberMessage(messages[index])) {
      return true;
    }
  }

  return false;
}

export function summarizeOperationalBundle(
  messages: OperationalBundleMemberMessage[]
): OperationalBundleSummary {
  if (messages.length === 0) {
    throw new Error("Cannot summarize an empty operational bundle");
  }

  const allSearchMisses = messages.every(isEmptyCompletedWebSearch);
  if (allSearchMisses) {
    return {
      title: "No results",
      details: formatDetails(messages),
    };
  }

  if (messages.length === 1) {
    return {
      title: singletonTitle(messages[0]),
      details: formatDetails(messages),
    };
  }

  return {
    title: `Ran ${messages.length.toLocaleString()} operations`,
    details: formatDetails(messages),
  };
}

function isBundleableToolMessage(message: DisplayedMessage & { type: "tool" }): boolean {
  if (message.isPartial) {
    return false;
  }
  return (
    message.status === "completed" || message.status === "pending" || message.status === "executing"
  );
}

function isEmptyCompletedWebSearch(message: OperationalBundleMemberMessage): boolean {
  return (
    message.type === "tool" &&
    message.toolName === "web_search" &&
    message.status === "completed" &&
    getWebSearchResultCount(message.result) === 0
  );
}

function getWebSearchResultCount(result: unknown): number | undefined {
  const unwrapped = unwrapJsonResult(result);
  if (Array.isArray(unwrapped)) {
    return unwrapped.length;
  }
  if (isPlainObject(unwrapped) && Array.isArray(unwrapped.sources)) {
    return unwrapped.sources.length;
  }
  return undefined;
}

function unwrapJsonResult(result: unknown): unknown {
  if (isPlainObject(result) && result.type === "json" && "value" in result) {
    return result.value;
  }
  return result;
}

function isOperationalBundleMemberMessage(
  message: DisplayedMessage | undefined
): message is OperationalBundleMemberMessage {
  if (message?.type === "reasoning") {
    return message.isOnlyMessageContent !== true;
  }
  if (message?.type === "tool") {
    return isBundleableToolMessage(message);
  }
  return false;
}

function isActiveOperationalMessage(message: OperationalBundleMemberMessage): boolean {
  if (message.type === "reasoning") {
    return message.isStreaming;
  }
  return message.status === "pending" || message.status === "executing";
}

function singletonTitle(message: OperationalBundleMemberMessage): string {
  return OPERATIONAL_BUNDLE_CATEGORY_COPY[getOperationalBundleCategory(message)].singletonTitle;
}

function formatDetails(messages: OperationalBundleMemberMessage[]): string {
  const counts = new Map<OperationalBundleCategory, number>();
  for (const message of messages) {
    const category = getOperationalBundleCategory(message);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => {
      const copy = OPERATIONAL_BUNDLE_CATEGORY_COPY[category];
      const label = count === 1 ? copy.detailLabel : copy.detailLabelPlural;
      return `${count.toLocaleString()} ${label}`;
    })
    .join(" · ");
}

function getOperationalBundleCategory(
  message: OperationalBundleMemberMessage
): OperationalBundleCategory {
  if (message.type === "reasoning") {
    return "reasoning";
  }

  if (FILE_READ_TOOL_NAMES.has(message.toolName)) {
    return "read";
  }
  if (FILE_EDIT_TOOL_NAMES.has(message.toolName)) {
    return "edit";
  }
  if (message.toolName === "bash") {
    return "shell";
  }
  if (message.toolName === "web_search") {
    return "search";
  }
  if (message.toolName === "web_fetch") {
    return "fetch";
  }
  if (message.toolName === "agent_skill_read" || message.toolName === "agent_skill_read_file") {
    return "skill";
  }
  if (message.toolName === "ask_user_question") {
    return "question";
  }
  if (message.toolName === "task" || message.toolName === "task_await") {
    return "task";
  }

  return "tool";
}
