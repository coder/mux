/**
 * Media content stories (images)
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/Media",
};

// Placeholder image for stable visual testing
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%23374151' width='200' height='150'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3EImage%3C/text%3E%3C/svg%3E";

/** User message with images */
export const MessageWithImages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-images",
          messages: [
            createUserMessage("msg-1", "Here's the screenshot of the bug:", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 100000,
              images: [PLACEHOLDER_IMAGE, PLACEHOLDER_IMAGE],
            }),
            createAssistantMessage(
              "msg-2",
              "I can see the issue. The modal is rendering behind the sidebar.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
              }
            ),
          ],
        })
      }
    />
  ),
};
