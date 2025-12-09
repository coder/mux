/**
 * Stories for reviews feature
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setReviews, createReview } from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";

export default {
  ...appMeta,
  title: "App/Reviews",
};

/**
 * Shows reviews banner with multiple reviews in different states.
 * Banner appears above chat input as a thin collapsible stripe.
 */
export const ReviewsBanner: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-reviews";

        // Set up reviews
        setReviews(workspaceId, [
          createReview(
            "review-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry",
            "pending"
          ),
          createReview(
            "review-2",
            "src/utils/helpers.ts",
            "15",
            "This function could be simplified",
            "pending"
          ),
          createReview(
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
 * Shows empty state - no reviews banner when there are no reviews.
 */
export const NoReviews: AppStory = {
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

        setReviews(workspaceId, [
          createReview("review-1", "src/api/users.ts", "10-15", "Fixed the null check", "checked"),
          createReview("review-2", "src/utils/format.ts", "42", "Added error handling", "checked"),
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
 * Shows banner with many reviews to test scrolling.
 */
export const ManyReviews: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-many-reviews";

        // Create many reviews to test scroll behavior
        const reviewItems = Array.from({ length: 10 }, (_, i) =>
          createReview(
            `review-${i + 1}`,
            `src/components/Feature${i + 1}.tsx`,
            `${10 + i * 5}-${15 + i * 5}`,
            `Review comment ${i + 1}: This needs attention`,
            i < 7 ? "pending" : "checked"
          )
        );

        setReviews(workspaceId, reviewItems);

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
