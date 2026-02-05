/**
 * Media content stories (images)
 *
 * Tests image rendering in chat messages: multi-image galleries, diverse
 * image formats/sizes, and single-image layout.
 */

import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { STABLE_TIMESTAMP, createUserMessage, createAssistantMessage } from "./mockFactory";
import { setupSimpleChatStory } from "./storyHelpers";

export default {
  ...appMeta,
  title: "App/Media",
};

// ─── Placeholder images for stable visual testing ────────────────────────────
// Each variant has a distinct size and color so they're visually distinguishable
// in stories without relying on real image assets.

/** Generic small image (200×150, dark gray) */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%23374151' width='200' height='150'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3EImage%3C/text%3E%3C/svg%3E";

/** Wide screenshot (400×300, dark bg with monitor-like label) */
const PLACEHOLDER_SCREENSHOT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%231f2937' width='400' height='300'/%3E%3Crect fill='%23374151' x='20' y='20' width='360' height='260' rx='4'/%3E%3Ctext fill='%236b7280' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='14'%3EScreenshot 400%C3%97300%3C/text%3E%3C/svg%3E";

/** Square diagram (300×300, blue-ish bg) */
const PLACEHOLDER_DIAGRAM =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%231e3a5f' width='300' height='300'/%3E%3Crect fill='%23264b73' x='30' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='170' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='100' y='200' width='100' height='60' rx='4'/%3E%3Cline x1='130' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Cline x1='170' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Ctext fill='%237eb8da' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='13'%3EDiagram 300%C3%97300%3C/text%3E%3C/svg%3E";

/** Small photo (200×150, green-ish bg) */
const PLACEHOLDER_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%231a3a2a' width='200' height='150'/%3E%3Ccircle cx='150' cy='40' r='20' fill='%232d5a3e'/%3E%3Cpolygon points='0,150 80,60 200,150' fill='%23265e3a'/%3E%3Ctext fill='%2388c9a0' x='50%25' y='40%25' text-anchor='middle' dy='.3em' font-size='12'%3EPhoto 200%C3%97150%3C/text%3E%3C/svg%3E";

// ─── Stories ─────────────────────────────────────────────────────────────────

/** Multi-turn bug report with screenshots — user sends images, assistant analyzes, user confirms fix */
export const MessageWithImages: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-images",
          messages: [
            createUserMessage(
              "msg-1",
              "Here's the screenshot of the bug — the modal renders behind the sidebar on Chrome. You can see the overlay is partially hidden:",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 100000,
                images: [PLACEHOLDER_SCREENSHOT, PLACEHOLDER_SCREENSHOT],
              }
            ),
            createAssistantMessage(
              "msg-2",
              "I can see the z-index issue. The sidebar has `z-index: 50` but the modal overlay is only `z-index: 40`.\n\nThe fix is straightforward — we need to bump the modal overlay above the sidebar:\n\n```css\n.modal-overlay {\n  z-index: 60; /* above sidebar (z-50) */\n}\n```\n\nLet me apply that change.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 90000,
              }
            ),
            createUserMessage(
              "msg-3",
              "Nice, that was fast. Here's what it looks like after the fix — full page and a close-up of the modal:",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 80000,
                images: [PLACEHOLDER_SCREENSHOT, PLACEHOLDER_IMAGE],
              }
            ),
            createAssistantMessage(
              "msg-4",
              "That looks correct now — the modal properly overlays the sidebar and the backdrop covers the full viewport. The close button is also accessible in the top-right corner.\n\nI'll commit this as `fix: bump modal overlay z-index above sidebar`.",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 70000,
              }
            ),
          ],
        })
      }
    />
  ),
};

/** Conversation with diverse image types — screenshot, architecture diagram, and photo reference */
export const MultipleImageFormats: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-multi-format",
          messages: [
            createUserMessage(
              "fmt-1",
              "I'm trying to redesign our notification system. Here's the current UI, the architecture diagram, and a reference photo from a design I liked:",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 60000,
                images: [PLACEHOLDER_SCREENSHOT, PLACEHOLDER_DIAGRAM, PLACEHOLDER_PHOTO],
              }
            ),
            createAssistantMessage(
              "fmt-2",
              "Thanks for sharing all three references. Here's what I see:\n\n1. **Current UI** — the notifications panel is a simple stacked list with no grouping. Read/unread states aren't visually distinct.\n2. **Architecture** — you have a pub/sub system feeding into a notification service, which makes sense for real-time delivery.\n3. **Design reference** — I like the grouped-by-time approach with the subtle left border accent for unread items.\n\nI'd suggest we start by grouping notifications by time (today, yesterday, earlier) and adding a colored left border for unread state. Want me to scaffold that?",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 50000,
              }
            ),
            createUserMessage(
              "fmt-3",
              "Yes, let's go with that approach. Here's one more reference for the empty state:",
              {
                historySequence: 3,
                timestamp: STABLE_TIMESTAMP - 40000,
                images: [PLACEHOLDER_PHOTO],
              }
            ),
            createAssistantMessage(
              "fmt-4",
              "Got it — a friendly illustration with a \"You're all caught up\" message. I'll create the grouped notification list component first, then add the empty state. Give me a few minutes.",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 30000,
              }
            ),
          ],
        })
      }
    />
  ),
};

/** Single large image — tests the non-gallery (single-image) layout path */
export const SingleLargeImage: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-single-image",
          messages: [
            createUserMessage(
              "single-1",
              "Can you review this architecture diagram? I want to make sure the data flow between the API gateway and the worker pool makes sense.",
              {
                historySequence: 1,
                timestamp: STABLE_TIMESTAMP - 20000,
                images: [PLACEHOLDER_DIAGRAM],
              }
            ),
            createAssistantMessage(
              "single-2",
              "The overall flow looks solid. The API gateway fans out to the worker pool correctly, and the two downstream services connect back through the event bus.\n\nOne thing I'd change: the direct connection from the worker pool to the database should go through your repository layer instead. That way you keep the same transaction boundaries and connection pooling you already have in the API path.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 10000,
              }
            ),
          ],
        })
      }
    />
  ),
};
