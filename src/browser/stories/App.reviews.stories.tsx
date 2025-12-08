/**
 * Stories for pending reviews feature
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setPendingReviews, createPendingReview } from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Reviews",
};

/**
 * Shows pending reviews banner with multiple reviews in different states.
 * Banner appears above chat input as a thin collapsible stripe.
 */
export const PendingReviewsBanner: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-reviews";

        // Set up pending reviews
        setPendingReviews(workspaceId, [
          createPendingReview(
            "review-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry",
            "pending"
          ),
          createPendingReview(
            "review-2",
            "src/utils/helpers.ts",
            "15",
            "This function could be simplified",
            "pending"
          ),
          createPendingReview(
            "review-3",
            "src/components/Button.tsx",
            "23-25",
            "Already addressed in another PR",
            "checked"
          ),
        ]);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/auth",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Add authentication to the API", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll help you add authentication.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
};

/**
 * Shows empty state - no pending reviews banner when there are no reviews.
 */
export const NoPendingReviews: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        return setupSimpleChatStory({
          workspaceId: "ws-no-reviews",
          workspaceName: "feature/clean",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me refactor this code", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'd be happy to help with refactoring.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
};

/**
 * Shows banner with only checked reviews (all pending resolved).
 */
export const AllReviewsChecked: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-all-checked";

        setPendingReviews(workspaceId, [
          createPendingReview(
            "review-1",
            "src/api/users.ts",
            "10-15",
            "Fixed the null check",
            "checked"
          ),
          createPendingReview(
            "review-2",
            "src/utils/format.ts",
            "42",
            "Added error handling",
            "checked"
          ),
        ]);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/fixes",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Fix the reported issues", { historySequence: 1 }),
            createAssistantMessage("msg-2", "All issues have been addressed.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
};

/**
 * Shows banner with many pending reviews to test scrolling.
 */
export const ManyPendingReviews: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-many-reviews";

        // Create many reviews to test scroll behavior
        const reviews = Array.from({ length: 10 }, (_, i) =>
          createPendingReview(
            `review-${i + 1}`,
            `src/components/Feature${i + 1}.tsx`,
            `${10 + i * 5}-${15 + i * 5}`,
            `Review comment ${i + 1}: This needs attention`,
            i < 7 ? "pending" : "checked"
          )
        );

        setPendingReviews(workspaceId, reviews);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/big-refactor",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Review all the changes", { historySequence: 1 }),
            createAssistantMessage(
              "msg-2",
              "I've reviewed the changes. There are several items to address.",
              {
                historySequence: 2,
              }
            ),
          ],
        });
      }}
    />
  ),
};
