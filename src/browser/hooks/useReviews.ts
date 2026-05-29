/**
 * Hook for managing reviews per workspace
 * Provides interface for adding, checking, and removing reviews
 */

import { useCallback, useMemo } from "react";
import { usePersistedState } from "./usePersistedState";
import { getReviewsKey } from "@/common/constants/storage";
import type { Review, ReviewsState, ReviewNoteData } from "@/common/types/review";

/**
 * Generate a unique ID for a review
 */
function generateReviewId(): string {
  return `review-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export interface UseReviewsReturn {
  /** All reviews (pending, attached, and checked) */
  reviews: Review[];
  /** Count of pending reviews (not attached, not checked) */
  pendingCount: number;
  /** Count of attached reviews (in chat input draft) */
  attachedCount: number;
  /** Count of checked reviews */
  checkedCount: number;
  /** Reviews currently attached to chat input */
  attachedReviews: Review[];
  /** Add a new review from structured data (starts as attached) */
  addReview: (data: ReviewNoteData) => Review;
  /** Mark a review as attached to chat input */
  attachReview: (reviewId: string) => void;
  /** Detach a review from chat input (back to pending) */
  detachReview: (reviewId: string) => void;
  /** Attach all pending reviews to chat input */
  attachAllPending: () => void;
  /** Detach all attached reviews from chat input (back to pending) */
  detachAllAttached: () => void;
  /** Mark a review as checked (sent) */
  checkReview: (reviewId: string) => void;
  /** Uncheck a review (mark as pending again) */
  uncheckReview: (reviewId: string) => void;
  /** Remove a review entirely */
  removeReview: (reviewId: string) => void;
  /** Update a review's note/comment */
  updateReviewNote: (reviewId: string, newNote: string) => void;
  /** Clear all checked reviews */
  clearChecked: () => void;
  /** Clear all reviews (for error recovery) */
  clearAll: () => void;
  /** Get a review by ID */
  getReview: (reviewId: string) => Review | undefined;
}

/**
 * Hook for managing reviews for a workspace
 * Persists reviews to localStorage
 */
export function useReviews(workspaceId: string): UseReviewsReturn {
  const [state, setState] = usePersistedState<ReviewsState>(
    getReviewsKey(workspaceId),
    {
      workspaceId,
      reviews: {},
      lastUpdated: Date.now(),
    },
    { listener: true } // Enable cross-component sync so banner updates when AIView adds reviews
  );

  // Convert reviews object to sorted array (oldest first - newest at end)
  const reviews = useMemo(() => {
    return Object.values(state.reviews).sort((a, b) => a.createdAt - b.createdAt);
  }, [state.reviews]);

  // Filter reviews by status
  const attachedReviews = useMemo(() => {
    return reviews.filter((r) => r.status === "attached");
  }, [reviews]);

  // Count reviews by status
  const pendingCount = useMemo(() => {
    return reviews.filter((r) => r.status === "pending").length;
  }, [reviews]);

  const attachedCount = attachedReviews.length;

  const checkedCount = useMemo(() => {
    return reviews.filter((r) => r.status === "checked").length;
  }, [reviews]);

  const addReview = useCallback(
    (data: ReviewNoteData): Review => {
      const review: Review = {
        id: generateReviewId(),
        data,
        status: "attached", // New reviews start attached to chat input
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

  const attachReview = useCallback(
    (reviewId: string) => {
      setState((prev) => {
        const review = prev.reviews[reviewId];
        if (!review || review.status === "attached") return prev;

        return {
          ...prev,
          reviews: {
            ...prev.reviews,
            [reviewId]: {
              ...review,
              status: "attached",
              statusChangedAt: Date.now(),
            },
          },
          lastUpdated: Date.now(),
        };
      });
    },
    [setState]
  );

  const detachReview = useCallback(
    (reviewId: string) => {
      setState((prev) => {
        const review = prev.reviews[reviewId];
        if (review?.status !== "attached") return prev;

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

  const attachAllPending = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const updated = { ...prev.reviews };
      let hasChanges = false;

      for (const [id, review] of Object.entries(prev.reviews)) {
        if (review.status === "pending") {
          updated[id] = { ...review, status: "attached", statusChangedAt: now };
          hasChanges = true;
        }
      }

      if (!hasChanges) return prev;
      return { ...prev, reviews: updated, lastUpdated: now };
    });
  }, [setState]);

  const detachAllAttached = useCallback(() => {
    setState((prev) => {
      const now = Date.now();
      const updated = { ...prev.reviews };
      let hasChanges = false;

      for (const [id, review] of Object.entries(prev.reviews)) {
        if (review.status === "attached") {
          updated[id] = { ...review, status: "pending", statusChangedAt: now };
          hasChanges = true;
        }
      }

      if (!hasChanges) return prev;
      return { ...prev, reviews: updated, lastUpdated: now };
    });
  }, [setState]);

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

  const updateReviewNote = useCallback(
    (reviewId: string, newNote: string) => {
      setState((prev) => {
        const review = prev.reviews[reviewId];
        if (!review) return prev;

        return {
          ...prev,
          reviews: {
            ...prev.reviews,
            [reviewId]: {
              ...review,
              data: {
                ...review.data,
                userNote: newNote,
              },
            },
          },
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

  const clearAll = useCallback(() => {
    setState((prev) => ({
      ...prev,
      reviews: {},
      lastUpdated: Date.now(),
    }));
  }, [setState]);

  const getReview = useCallback(
    (reviewId: string): Review | undefined => {
      return state.reviews[reviewId];
    },
    [state.reviews]
  );

  return useMemo(
    () => ({
      reviews,
      pendingCount,
      attachedCount,
      checkedCount,
      attachedReviews,
      addReview,
      attachReview,
      detachReview,
      attachAllPending,
      detachAllAttached,
      checkReview,
      uncheckReview,
      removeReview,
      updateReviewNote,
      clearChecked,
      clearAll,
      getReview,
    }),
    [
      reviews,
      pendingCount,
      attachedCount,
      checkedCount,
      attachedReviews,
      addReview,
      attachReview,
      detachReview,
      attachAllPending,
      detachAllAttached,
      checkReview,
      uncheckReview,
      removeReview,
      updateReviewNote,
      clearChecked,
      clearAll,
      getReview,
    ]
  );
}
