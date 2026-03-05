import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/storyHelpers.js";
import {
  STABLE_TIMESTAMP,
  createAssistantMessage,
  createUserMessage,
} from "@/browser/stories/mockFactory";
import { within, userEvent, waitFor } from "@storybook/test";
import { warmHashCache, setShareData } from "@/browser/utils/sharedUrlCache";

const meta = {
  ...appMeta,
  title: "App/Chat/Components/ShareSigningBadges",
};

export default meta;

// Message content used in SigningBadgePassphraseWarning story
const SIGNING_WARNING_MESSAGE_CONTENT = "Hello! How can I help you today?";
/**
 * Story showing the signing badge in warning state when key requires passphrase.
 * The signing badge displays yellow when a compatible key exists but is passphrase-protected.
 */
export const SigningBadgePassphraseWarning: AppStory = {
  // Use loaders to pre-warm hash cache before component mounts (fixes race condition)
  loaders: [
    async () => {
      // Warm the hash cache to ensure consistent hashing
      await warmHashCache(SIGNING_WARNING_MESSAGE_CONTENT);
      // Now set share data with the warmed hash
      setShareData(SIGNING_WARNING_MESSAGE_CONTENT, {
        url: "https://mux.md/story-test#fake-key",
        id: "story-share-id",
        mutateKey: "story-mutate-key",
        expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
        signed: false,
      });
      return {};
    },
  ],
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-signing-warning",
          messages: [
            createUserMessage("msg-1", "Hello", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage("msg-2", SIGNING_WARNING_MESSAGE_CONTENT, {
              historySequence: 2,
              timestamp: STABLE_TIMESTAMP - 290000,
            }),
          ],
          signingCapabilities: {
            publicKey: null,
            githubUser: null,
            error: {
              message:
                "Signing key requires a passphrase. Create an unencrypted key at ~/.mux/message_signing_key or use ssh-add.",
              hasEncryptedKey: true,
            },
          },
        })
      }
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for the assistant message to appear
    await canvas.findByText(SIGNING_WARNING_MESSAGE_CONTENT);

    // Wait for React to finish any pending updates after rendering
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Find and click the Share button (should show "Already shared" due to loader)
    const shareButton = await canvas.findByLabelText("Already shared");

    // Wait a bit for button to be fully interactive
    await new Promise((r) => setTimeout(r, 100));
    await userEvent.click(shareButton);

    // Wait for the popover to open (renders in a portal, so search document)
    await waitFor(() => {
      const popover = document.querySelector('[role="dialog"]');
      if (!popover) throw new Error("Share popover not found");
    });

    // Allow the signing badge to render with its warning state
    await new Promise((r) => setTimeout(r, 200));
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the signing badge in warning state (yellow) when a signing key exists but is passphrase-protected.",
      },
    },
  },
};
