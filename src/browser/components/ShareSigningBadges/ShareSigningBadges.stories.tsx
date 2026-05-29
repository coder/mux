import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, waitFor, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { SigningBadge } from "./ShareSigningBadges.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Components/ShareSigningBadges",
  component: SigningBadge,
} satisfies Meta<typeof SigningBadge>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Story showing the signing badge in warning state when key requires passphrase.
 * The signing badge displays yellow when a compatible key exists but is passphrase-protected.
 */
export const SigningBadgePassphraseWarning: Story = {
  args: {
    signed: false,
    signingEnabled: true,
    capabilities: {
      publicKey: null,
      githubUser: null,
      error: {
        message:
          "Signing key requires a passphrase. Create an unencrypted key at ~/.mux/message_signing_key or use ssh-add.",
        hasEncryptedKey: true,
      },
    },
  },
  render: (args) => (
    <div className="bg-background flex min-h-[180px] items-start p-6">
      <SigningBadge {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const badge = await canvas.findByRole("button", { name: /disable signing/i });

    await userEvent.hover(badge);

    await waitFor(
      () => {
        const tooltip = document.querySelector('[role="tooltip"]');
        if (!(tooltip instanceof HTMLElement)) {
          throw new Error("Signing warning tooltip not visible");
        }
        if (!tooltip.textContent?.includes("Key requires passphrase")) {
          throw new Error("Expected passphrase warning content in tooltip");
        }
      },
      { interval: 50, timeout: 5000 }
    );
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
