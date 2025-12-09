/**
 * Stories for reviews feature
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setReviews, createReview } from "./storyHelpers";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";

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

/**
 * Shows multiple attached reviews in ChatInput with "Clear all" button.
 * Also shows pending reviews in banner with "Attach all to chat" button.
 */
export const BulkReviewActions: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-bulk-reviews";

        setReviews(workspaceId, [
          // Attached reviews - shown in ChatInput with "Clear all" button
          createReview(
            "review-attached-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry",
            "attached"
          ),
          createReview(
            "review-attached-2",
            "src/utils/helpers.ts",
            "15-20",
            "This function could be simplified using reduce",
            "attached"
          ),
          createReview(
            "review-attached-3",
            "src/hooks/useAuth.ts",
            "30-35",
            "Missing error handling for network failures",
            "attached"
          ),
          // Pending reviews - shown in banner with "Attach all to chat" button
          createReview(
            "review-pending-1",
            "src/components/LoginForm.tsx",
            "55-60",
            "Add loading state while authenticating",
            "pending"
          ),
          createReview(
            "review-pending-2",
            "src/services/api.ts",
            "12-18",
            "Consider adding retry logic for failed requests",
            "pending"
          ),
          createReview(
            "review-pending-3",
            "src/types/user.ts",
            "5-10",
            "Make email field optional for guest users",
            "pending"
          ),
        ]);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/auth-improvements",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me fix the authentication issues", {
              historySequence: 1,
            }),
            createAssistantMessage("msg-2", "I'll help you address the authentication issues.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Expand the ReviewsBanner to show "Attach all to chat" button
    // The banner shows "3 pending reviews" but number is in separate span,
    // so we click on "pending review" text
    await waitFor(async () => {
      const bannerButton = canvas.getByText(/pending review/i);
      await userEvent.click(bannerButton);
    });

    // Wait for any auto-focus timers, then blur
    await new Promise((resolve) => setTimeout(resolve, 150));
    (document.activeElement as HTMLElement)?.blur();
  },
};
