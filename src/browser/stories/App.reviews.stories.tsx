/**
 * Stories for reviews feature
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { setupSimpleChatStory, setReviews, createReview } from "./storyHelpers";
import { blurActiveElement, waitForChatInputAutofocusDone } from "./storyPlayHelpers.js";
import { createUserMessage, createAssistantMessage } from "./mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";
import type { WorkspaceChatMessage } from "@/common/orpc/types";

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

        // Use deterministic timestamps so reviews render in stable order
        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          createReview(
            "review-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry",
            "pending",
            baseTime + 1
          ),
          createReview(
            "review-2",
            "src/utils/helpers.ts",
            "15",
            "This function could be simplified",
            "pending",
            baseTime + 2
          ),
          createReview(
            "review-3",
            "src/components/Button.tsx",
            "23-25",
            "Already addressed in another PR",
            "checked",
            baseTime + 3
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

        // Use deterministic timestamps so reviews render in stable order
        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          createReview(
            "review-1",
            "src/api/users.ts",
            "10-15",
            "Fixed the null check",
            "checked",
            baseTime + 1
          ),
          createReview(
            "review-2",
            "src/utils/format.ts",
            "42",
            "Added error handling",
            "checked",
            baseTime + 2
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
 * Shows banner with many reviews to test scrolling.
 */
export const ManyReviews: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-many-reviews";

        // Create many reviews to test scroll behavior
        // Use deterministic timestamps so reviews render in stable order
        const baseTime = 1700000000000;
        const reviewItems = Array.from({ length: 10 }, (_, i) =>
          createReview(
            `review-${i + 1}`,
            `src/components/Feature${i + 1}.tsx`,
            `${10 + i * 5}-${15 + i * 5}`,
            `Review comment ${i + 1}: This needs attention`,
            i < 7 ? "pending" : "checked",
            baseTime + i + 1
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

        // Use deterministic timestamps so reviews render in stable order
        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          // Attached reviews - shown in ChatInput with "Clear all" button
          createReview(
            "review-attached-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry",
            "attached",
            baseTime + 1
          ),
          createReview(
            "review-attached-2",
            "src/utils/helpers.ts",
            "15-20",
            "This function could be simplified using reduce",
            "attached",
            baseTime + 2
          ),
          createReview(
            "review-attached-3",
            "src/hooks/useAuth.ts",
            "30-35",
            "Missing error handling for network failures",
            "attached",
            baseTime + 3
          ),
          // Pending reviews - shown in banner with "Attach all to chat" button
          createReview(
            "review-pending-1",
            "src/components/LoginForm.tsx",
            "55-60",
            "Add loading state while authenticating",
            "pending",
            baseTime + 4
          ),
          createReview(
            "review-pending-2",
            "src/services/api.ts",
            "12-18",
            "Consider adding retry logic for failed requests",
            "pending",
            baseTime + 5
          ),
          createReview(
            "review-pending-3",
            "src/types/user.ts",
            "5-10",
            "Make email field optional for guest users",
            "pending",
            baseTime + 6
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

    // Wait for ChatInput's auto-focus attempt to finish, then blur
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

/**
 * Shows attached reviews with multi-line comments to verify whitespace preservation.
 * Comments should preserve newlines and indentation.
 */
export const MultiLineComments: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-multiline-comments";

        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          createReview(
            "review-multiline-1",
            "src/api/auth.ts",
            "42-55",
            "This function has several issues:\n\n1. Missing error handling\n2. Token expiry should be configurable\n3. Consider adding retry logic",
            "attached",
            baseTime + 1
          ),
          createReview(
            "review-multiline-2",
            "src/utils/validation.ts",
            "10-20",
            "The validation logic needs work:\n  - Add null checks\n  - Handle edge cases\n  - Add unit tests",
            "attached",
            baseTime + 2
          ),
        ]);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/code-review",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Fix these issues", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll address the review comments.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

/**
 * Shows reviews in a queued message with nice formatting.
 * The queued message appears when the user sends a message while the assistant is busy.
 * Reviews are displayed with proper formatting (file path, line range, code snippet, comment).
 */
export const QueuedMessageWithReviews: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-queued-reviews";

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/auth",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Help me fix authentication", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll analyze the code and help you fix it...", {
              historySequence: 2,
            }),
          ],
          onChat: (wsId, emit) => {
            // Emit the queued message with reviews (simulating user queued a message with reviews)
            emit({
              type: "queued-message-changed",
              workspaceId: wsId,
              queuedMessages: ["Please also check this issue"],
              displayText: "Please also check this issue",
              reviews: [
                {
                  filePath: "src/api/auth.ts",
                  lineRange: "42-48",
                  selectedCode:
                    "const token = generateToken();\nconst expiry = Date.now() + 3600000;",
                  userNote: "Consider using a constant for the token expiry duration",
                },
                {
                  filePath: "src/utils/helpers.ts",
                  lineRange: "15",
                  selectedCode: "function validate(input) { return input.length > 0; }",
                  userNote: "This validation could be more robust",
                },
              ],
            } as WorkspaceChatMessage);
          },
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    // Wait for the queued message to appear
    const canvas = within(canvasElement);
    await waitFor(() => {
      canvas.getByText("Queued");
    });
    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};

/**
 * Shows attached review with hover actions visible.
 * Demonstrates the edit, check, detach, and delete buttons that appear on hover.
 */
export const AttachedReviewHoverActions: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-hover-actions";

        const baseTime = 1700000000000;
        setReviews(workspaceId, [
          createReview(
            "review-hover-1",
            "src/api/auth.ts",
            "42-48",
            "Consider using a constant for the token expiry duration instead of hardcoding 3600000",
            "attached",
            baseTime + 1
          ),
        ]);

        return setupSimpleChatStory({
          workspaceId,
          workspaceName: "feature/auth",
          projectName: "my-app",
          messages: [
            createUserMessage("msg-1", "Fix the auth token handling", { historySequence: 1 }),
            createAssistantMessage("msg-2", "I'll help you fix the authentication.", {
              historySequence: 2,
            }),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);

    // Wait for the attached review to appear
    await waitFor(() => {
      canvas.getByText(/src\/api\/auth\.ts:L42-48/);
    });

    // Hover over the review block to reveal action buttons
    const reviewBlock = canvasElement.querySelector("[class*='group/review']");
    if (reviewBlock) {
      await userEvent.hover(reviewBlock);
    }

    await waitForChatInputAutofocusDone(canvasElement);
    blurActiveElement();
  },
};
