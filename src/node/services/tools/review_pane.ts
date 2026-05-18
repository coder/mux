import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { AssistedReviewHunk } from "@/common/types/review";
import {
  ASSISTED_REVIEW_MAX_HUNKS,
  formatAssistedFilter,
  parseAssistedFilter,
} from "@/common/utils/review/assistedReview";

/**
 * In-memory per-workspace store for the Assisted Review hunks the agent has
 * flagged via `review_pane_update`. Not persisted to disk: this set tracks
 * the agent's *current* focus and is naturally rebuilt by replaying tool
 * results from chat history when the workspace reloads (handled by
 * StreamingMessageAggregator.processToolResult).
 */
class AssistedReviewManager {
  private byWorkspace = new Map<string, AssistedReviewHunk[]>();

  get(workspaceId: string): AssistedReviewHunk[] {
    return this.byWorkspace.get(workspaceId) ?? [];
  }

  set(workspaceId: string, hunks: AssistedReviewHunk[]): AssistedReviewHunk[] {
    if (hunks.length === 0) {
      this.byWorkspace.delete(workspaceId);
      return [];
    }
    this.byWorkspace.set(workspaceId, hunks);
    return hunks;
  }

  clear(workspaceId: string): void {
    this.byWorkspace.delete(workspaceId);
  }
}

export const assistedReviewManager = new AssistedReviewManager();

interface ReviewPaneUpdateArgs {
  operation: "add" | "replace";
  hunks: Array<{ path: string; comment?: string | null }>;
}

/**
 * Apply an update operation against an existing list. Exported for testing
 * and to keep mutation logic in one place; the tool factory wraps this with
 * IO/validation.
 */
export function applyReviewPaneUpdate(
  current: readonly AssistedReviewHunk[],
  args: ReviewPaneUpdateArgs
): { hunks: AssistedReviewHunk[]; rejected: string[] } {
  const rejected: string[] = [];
  const parsed: AssistedReviewHunk[] = [];

  for (const raw of args.hunks) {
    const filter = parseAssistedFilter(raw.path);
    if (!filter) {
      rejected.push(raw.path);
      continue;
    }
    const trimmedComment = raw.comment?.trim();
    parsed.push({
      path: filter.path,
      range: filter.range,
      // Drop empty-after-trim comments so the UI doesn't render an empty
      // assisted-comment row.
      comment: trimmedComment && trimmedComment.length > 0 ? trimmedComment : undefined,
    });
  }

  const base = args.operation === "add" ? [...current] : [];
  // Dedup by formatted path:range key, preferring the latest comment when
  // the same region is flagged twice (typical when an agent calls `add`
  // and then re-flags a refined comment).
  const seen = new Map<string, number>();
  for (const h of base) {
    seen.set(formatAssistedFilter(h), base.indexOf(h));
  }
  for (const h of parsed) {
    const key = formatAssistedFilter(h);
    const existing = seen.get(key);
    if (existing !== undefined) {
      base[existing] = h;
    } else {
      seen.set(key, base.length);
      base.push(h);
    }
  }

  // Truncate defensively (single update can't exceed MAX, but `add` over time can).
  const truncated = base.slice(0, ASSISTED_REVIEW_MAX_HUNKS);
  return { hunks: truncated, rejected };
}

export const createReviewPaneUpdateTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.review_pane_update.description,
    inputSchema: TOOL_DEFINITIONS.review_pane_update.schema,
    execute: (args) => {
      assert(config.workspaceId, "review_pane_update requires a workspaceId");
      if (args.hunks.length > ASSISTED_REVIEW_MAX_HUNKS) {
        throw new Error(
          `Too many hunks in a single update (${args.hunks.length}/${ASSISTED_REVIEW_MAX_HUNKS}). ` +
            "Flag the most important regions and consider splitting into multiple calls."
        );
      }

      const current = assistedReviewManager.get(config.workspaceId);
      const { hunks, rejected } = applyReviewPaneUpdate(current, args);
      assistedReviewManager.set(config.workspaceId, hunks);

      return Promise.resolve({
        success: true as const,
        operation: args.operation,
        hunks: hunks.map((h) => ({
          path: formatAssistedFilter(h),
          comment: h.comment ?? null,
        })),
        rejected,
      });
    },
  });
};

export const createReviewPaneGetTool: ToolFactory = (config) => {
  return tool({
    description: TOOL_DEFINITIONS.review_pane_get.description,
    inputSchema: TOOL_DEFINITIONS.review_pane_get.schema,
    execute: () => {
      assert(config.workspaceId, "review_pane_get requires a workspaceId");
      const hunks = assistedReviewManager.get(config.workspaceId);
      return Promise.resolve({
        hunks: hunks.map((h) => ({
          path: formatAssistedFilter(h),
          comment: h.comment ?? null,
        })),
      });
    },
  });
};
