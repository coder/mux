/**
 * Hook for managing pending reviews per workspace
 * Provides interface for adding, checking, and removing reviews
 */

import { useCallback, useMemo } from "react";
import { usePersistedState } from "./usePersistedState";
import { getPendingReviewsKey } from "@/common/constants/storage";
import type { PendingReview, PendingReviewsState } from "@/common/types/review";

/**
 * Parse a review note to extract file path and line range
 * Expected format: <review>\nRe filePath:lineRange\n...
 */
function parseReviewNote(content: string): { filePath: string; lineRange: string } {
  const match = /Re ([^:]+):(\d+(?:-\d+)?)/.exec(content);
  if (match) {
    return { filePath: match[1], lineRange: match[2] };
  }
  return { filePath: "unknown", lineRange: "?" };
}

/**
 * Generate a unique ID for a review
 */
function generateReviewId(): string {
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface UsePendingReviewsReturn {
  /** All reviews (pending and checked) */
  reviews: PendingReview[];
  /** Count of pending (unchecked) reviews */
  pendingCount: number;
  /** Count of checked reviews */
  checkedCount: number;
  /** Add a new review from a review note */
  addReview: (content: string) => PendingReview;
  /** Mark a review as checked */
  checkReview: (reviewId: string) => void;
  /** Uncheck a review (mark as pending again) */
  uncheckReview: (reviewId: string) => void;
  /** Remove a review entirely */
  removeReview: (reviewId: string) => void;
  /** Clear all checked reviews */
  clearChecked: () => void;
  /** Get a review by ID */
  getReview: (reviewId: string) => PendingReview | undefined;
}

/**
 * Hook for managing pending reviews for a workspace
 * Persists reviews to localStorage
 */
export function usePendingReviews(workspaceId: string): UsePendingReviewsReturn {
  const [state, setState] = usePersistedState<PendingReviewsState>(
    getPendingReviewsKey(workspaceId),
    {
      workspaceId,
      reviews: {},
      lastUpdated: Date.now(),
    }
  );

  // Convert reviews object to sorted array (newest first)
  const reviews = useMemo(() => {
    return Object.values(state.reviews).sort((a, b) => b.createdAt - a.createdAt);
  }, [state.reviews]);

  // Count pending and checked reviews
  const pendingCount = useMemo(() => {
    return reviews.filter((r) => r.status === "pending").length;
  }, [reviews]);

  const checkedCount = useMemo(() => {
    return reviews.filter((r) => r.status === "checked").length;
  }, [reviews]);

  const addReview = useCallback(
    (content: string): PendingReview => {
      const { filePath, lineRange } = parseReviewNote(content);
      const review: PendingReview = {
        id: generateReviewId(),
        content,
        filePath,
        lineRange,
        status: "pending",
        createdAt: Date.now(),
      };

      setState((prev) => ({
        ...prev,
        reviews: {
          ...prev.reviews,
          [review.id]: review,
        },
        lastUpdated: Date.now(),
      }));

      return review;
    },
    [setState]
  );

  const checkReview = useCallback(
    (reviewId: string) => {
      setState((prev) => {
        const review = prev.reviews[reviewId];
        if (!review || review.status === "checked") return prev;

        return {
          ...prev,
          reviews: {
            ...prev.reviews,
            [reviewId]: {
              ...review,
              status: "checked",
              statusChangedAt: Date.now(),
            },
          },
          lastUpdated: Date.now(),
        };
      });
    },
    [setState]
  );

  const uncheckReview = useCallback(
    (reviewId: string) => {
      setState((prev) => {
        const review = prev.reviews[reviewId];
        if (!review || review.status === "pending") return prev;

        return {
          ...prev,
          reviews: {
            ...prev.reviews,
            [reviewId]: {
              ...review,
              status: "pending",
              statusChangedAt: Date.now(),
            },
          },
          lastUpdated: Date.now(),
        };
      });
    },
    [setState]
  );

  const removeReview = useCallback(
    (reviewId: string) => {
      setState((prev) => {
        const { [reviewId]: _, ...rest } = prev.reviews;
        return {
          ...prev,
          reviews: rest,
          lastUpdated: Date.now(),
        };
      });
    },
    [setState]
  );

  const clearChecked = useCallback(() => {
    setState((prev) => {
      const filtered = Object.fromEntries(
        Object.entries(prev.reviews).filter(([_, r]) => r.status !== "checked")
      );
      return {
        ...prev,
        reviews: filtered,
        lastUpdated: Date.now(),
      };
    });
  }, [setState]);

  const getReview = useCallback(
    (reviewId: string): PendingReview | undefined => {
      return state.reviews[reviewId];
    },
    [state.reviews]
  );

  return {
    reviews,
    pendingCount,
    checkedCount,
    addReview,
    checkReview,
    uncheckReview,
    removeReview,
    clearChecked,
    getReview,
  };
}
