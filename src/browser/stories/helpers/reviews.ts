import type { ReviewSortOrder } from "@/common/types/review";
import type { HunkFirstSeenState } from "@/browser/hooks/useHunkFirstSeen";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import type { Review } from "@/common/types/review";
import { getHunkFirstSeenKey, REVIEW_SORT_ORDER_KEY } from "@/common/constants/storage";

/** Set hunk first-seen timestamps for a workspace (for storybook) */
export function setHunkFirstSeen(workspaceId: string, firstSeen: Record<string, number>): void {
  const state: HunkFirstSeenState = { firstSeen };
  updatePersistedState(getHunkFirstSeenKey(workspaceId), state);
}

/** Set the review panel sort order (global) */
export function setReviewSortOrder(order: ReviewSortOrder): void {
  localStorage.setItem(REVIEW_SORT_ORDER_KEY, JSON.stringify(order));
}

/** Create a sample review for stories */
export function createReview(
  id: string,
  filePath: string,
  lineRange: string,
  note: string,
  status: "pending" | "attached" | "checked" = "pending",
  createdAt?: number
): Review {
  return {
    id,
    data: {
      filePath,
      lineRange,
      selectedCode: "// sample code",
      userNote: note,
    },
    status,
    createdAt: createdAt ?? Date.now(),
    statusChangedAt: status === "checked" ? Date.now() : undefined,
  };
}
