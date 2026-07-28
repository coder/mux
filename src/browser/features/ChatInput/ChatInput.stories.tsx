import type { AppStory } from "@/browser/stories/meta.js";
import { appMeta, AppWithMocks, PIXEL_DISABLED } from "@/browser/stories/meta.js";
import { setupSimpleChatStory } from "@/browser/stories/helpers/chatSetup";
import { collapseLeftSidebar, setWorkspaceInput } from "@/browser/stories/helpers/uiState";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { getModelKey } from "@/common/constants/storage";
import { createAssistantMessage, createUserMessage } from "@/browser/stories/mocks/messages";
import { createFileReadTool } from "@/browser/stories/mocks/tools";
import { STABLE_TIMESTAMP } from "@/browser/stories/mocks/workspaces";
import {
  blurActiveElement,
  waitForChatInputAutofocusDone,
} from "@/browser/stories/storyPlayHelpers.js";
import { within, userEvent, waitFor } from "@storybook/test";

const meta = { ...appMeta, title: "App/Chat/Input" };
export default meta;

/** Voice input button shows user education when OpenAI API key is not set */
export const VoiceInputNoApiKey: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          messages: [],
          // No OpenAI key configured - voice button should be disabled with tooltip
          providersConfig: {
            anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
            // openai deliberately missing
          },
        })
      }
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Shows the voice input button in disabled state when OpenAI API key is not configured. Hover over the mic icon in the chat input to see the user education tooltip.",
      },
    },
  },
};

export const FocusedComposer: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() =>
        setupSimpleChatStory({
          workspaceId: "ws-focus-border",
          messages: [],
        })
      }
    />
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    await waitForChatInputAutofocusDone(storyRoot);

    const textarea = await canvas.findByLabelText("Message Claude");
    const surface = storyRoot.querySelector('[data-component="ChatInputSurface"]');
    if (!surface) throw new Error("Composer surface not rendered");

    blurActiveElement();
    const blurredBorder = getComputedStyle(surface).borderColor;

    textarea.focus();
    await waitFor(() => {
      if (getComputedStyle(surface).borderColor === blurredBorder) {
        throw new Error(`Focusing the composer left its border at ${blurredBorder}`);
      }
    });
  },
};

/**
 * The composer control row collapses on container width, not viewport width, so a fixed-width
 * wrapper reproduces every stage: the play resizes the wrapper and asserts each one. Guarding on the
 * measured row width keeps the assertions honest if the surrounding layout ever changes, and each
 * stage also asserts the row does not overflow, since a threshold set too low trades a hidden label
 * for clipped controls.
 */
export const NarrowControlRowCollapse: AppStory = {
  render: () => (
    <div data-testid="composer-width-wrapper" style={{ width: 900, height: 700 }}>
      <AppWithMocks
        setup={() => {
          collapseLeftSidebar();
          // A pro-capable OpenAI model on a direct route is what makes the PRO chip render, so the
          // narrow-width assertions below can cover it too.
          updatePersistedState(getModelKey("ws-composer-breakpoints"), "openai:gpt-5.6-sol");
          return setupSimpleChatStory({
            workspaceId: "ws-composer-breakpoints",
            providersConfig: {
              openai: { apiKeySet: true, isEnabled: true, isConfigured: true },
            },
            messages: [
              createUserMessage("msg-1", "Summarize the composer layout rules", {
                historySequence: 1,
              }),
              createAssistantMessage("msg-2", "The control row collapses in two stages.", {
                historySequence: 2,
                contextUsage: { inputTokens: 120_000, outputTokens: 8_000 },
              }),
            ],
          });
        }}
      />
    </div>
  ),
  parameters: {
    ...appMeta.parameters,
    pixel: PIXEL_DISABLED,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    await waitForChatInputAutofocusDone(storyRoot);
    blurActiveElement();

    const wrapper = within(storyRoot).getByTestId("composer-width-wrapper");
    const agentTrigger = within(storyRoot).getByLabelText("Select agent");
    const contextTrigger = storyRoot.querySelector<HTMLElement>('[aria-label^="Context usage"]');
    if (!contextTrigger) throw new Error("Context usage control not rendered");

    const rowWidth = () => {
      const row = storyRoot.querySelector<HTMLElement>('[data-component="ComposerControlRow"]');
      if (!row) throw new Error("Composer control row not rendered");
      return row.getBoundingClientRect().width;
    };
    const meterVisible = () =>
      (storyRoot.querySelector("[data-context-usage-meter]")?.getBoundingClientRect().width ?? 0) >
      0;
    const proChip = storyRoot.querySelector<HTMLElement>('[data-component="ProModeToggle"]');
    if (!proChip) throw new Error("PRO chip not rendered; the story's model must be pro-capable");
    const proVisible = () => proChip.getBoundingClientRect().width > 0;

    async function resizeRowInto(wrapperWidth: number, min: number, max: number) {
      wrapper.style.width = `${wrapperWidth}px`;
      await waitFor(() => {
        const width = rowWidth();
        if (width <= min || width >= max) {
          throw new Error(
            `Wrapper ${wrapperWidth}px put the control row at ${Math.round(width)}px, outside the ${min}-${max}px band this assertion needs`
          );
        }
      });
    }

    const assertNoOverflow = (stage: string) => {
      const row = storyRoot.querySelector<HTMLElement>('[data-component="ComposerControlRow"]');
      if (!row) throw new Error("Composer control row not rendered");
      if (row.scrollWidth > row.clientWidth) {
        throw new Error(
          `Row overflows by ${row.scrollWidth - row.clientWidth}px at the ${stage} stage`
        );
      }
    };

    await resizeRowInto(400, 300, 341);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(`Agent pill should be icon-only, showing "${agentTrigger.innerText}"`);
      }
      if (!/^\d+%$/.test(contextTrigger.innerText.trim())) {
        throw new Error(
          `Context pill should be percentage-only, showing "${contextTrigger.innerText}"`
        );
      }
      if (meterVisible()) throw new Error("Context meter should be hidden on an icon-only row");
      if (proVisible()) throw new Error("PRO chip should be hidden on the tightest row");
      assertNoOverflow("tightest");
    });

    await resizeRowInto(425, 344, 359);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(
          `Agent pill should still be icon-only at or below 360px, showing "${agentTrigger.innerText}"`
        );
      }
      if (!proVisible()) throw new Error("PRO chip should return once the row clears 340px");
      assertNoOverflow("pro-returns");
    });

    // Phone-width workspace rows land here. The agent label does not fit alongside the context pill
    // yet, so it must stay hidden rather than clip, and the model name must keep its own room.
    await resizeRowInto(474, 365, 445);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() !== "") {
        throw new Error(
          `Agent pill should stay icon-only while the context pill shares the row, showing "${agentTrigger.innerText}"`
        );
      }
      assertNoOverflow("phone-width");

      const modelName = storyRoot.querySelector<HTMLElement>(
        '[data-component="ModelSelectorGroup"] button span'
      );
      if (!modelName) throw new Error("Model name not rendered");
      if (modelName.scrollWidth > modelName.clientWidth) {
        throw new Error(
          `Model name is clipped to "${modelName.innerText}" at a phone-width row that has room for it`
        );
      }
    });

    await resizeRowInto(544, 455, 495);
    await waitFor(() => {
      if (agentTrigger.innerText.trim() === "") {
        throw new Error("Agent pill should show its label once the row clears 450px");
      }
      if (!/^\d+%$/.test(contextTrigger.innerText.trim())) {
        throw new Error(
          `Context pill should stay percentage-only at or below 500px, showing "${contextTrigger.innerText}"`
        );
      }
      if (meterVisible()) throw new Error("Context meter should stay hidden at or below 500px");
      if (!proVisible()) throw new Error("PRO chip should stay visible above 340px");
      assertNoOverflow("agent-label-returns");
    });

    await resizeRowInto(640, 505, 1200);
    await waitFor(() => {
      if (!contextTrigger.innerText.includes("Context")) {
        throw new Error(
          `Context pill should regain its label above 500px, showing "${contextTrigger.innerText}"`
        );
      }
      if (!meterVisible()) throw new Error("Context meter should be visible above 500px");
      assertNoOverflow("full-detail");

      // Checked here rather than on a narrow row because a narrow row is under flex-shrink pressure,
      // which trims a fixed width down to roughly its content width and hides the difference. With
      // slack available, a fixed width sits at its full cap while a content-sized one does not.
      const modelTrigger = storyRoot.querySelector<HTMLElement>(
        '[data-component="ModelSelectorGroup"] button'
      );
      if (!modelTrigger) throw new Error("Model trigger not rendered");
      const triggerWidth = modelTrigger.getBoundingClientRect().width;
      const capPx = 8 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (triggerWidth >= capPx - 8) {
        throw new Error(
          `Model trigger reserves ${Math.round(triggerWidth)}px of its ${Math.round(capPx)}px cap for a short name instead of sizing to content`
        );
      }
    });
  },
};

/**
 * Editing message state - shows the edit cutoff barrier and amber-styled input.
 * Demonstrates the UI when a user clicks "Edit" on a previous message.
 */
export const EditingMessage: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        const workspaceId = "ws-editing";

        // Ensure a deterministic starting state (Storybook can preserve localStorage
        // across story runs in the same session).
        setWorkspaceInput(workspaceId, "");

        return setupSimpleChatStory({
          workspaceId,
          messages: [
            createUserMessage("msg-1", "Add authentication to the user API endpoint", {
              historySequence: 1,
              timestamp: STABLE_TIMESTAMP - 300000,
            }),
            createAssistantMessage(
              "msg-2",
              "I'll help you add authentication. Let me check the current implementation and add JWT validation.",
              {
                historySequence: 2,
                timestamp: STABLE_TIMESTAMP - 290000,
                toolCalls: [
                  createFileReadTool(
                    "call-1",
                    "src/api/users.ts",
                    "export function getUser(req, res) {\n  const user = db.users.find(req.params.id);\n  res.json(user);\n}"
                  ),
                ],
              }
            ),
            createUserMessage("msg-3", "Actually, can you use a different approach?", {
              historySequence: 3,
              timestamp: STABLE_TIMESTAMP - 280000,
            }),
            createAssistantMessage(
              "msg-4",
              "Of course! I can use a different authentication approach. What would you prefer?",
              {
                historySequence: 4,
                timestamp: STABLE_TIMESTAMP - 270000,
              }
            ),
          ],
        });
      }}
    />
  ),
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;
    const canvas = within(storyRoot);

    // Wait for user message actions to render (Edit buttons only appear on user messages)
    const editButtons = await canvas.findAllByLabelText("Edit", {}, { timeout: 10000 });
    if (editButtons.length === 0) throw new Error("No edit buttons found");

    // Click edit on the first user message
    await userEvent.click(editButtons[0]);

    // Wait for the editing state to be applied
    await waitFor(() => {
      canvas.getByLabelText("Edit your last message");
      const surface = storyRoot.querySelector('[data-component="ChatInputSurface"]');
      if (!surface?.classList.contains("border-editing-mode")) {
        throw new Error("Composer surface not in editing state");
      }
    });

    // Verify the edit cutoff barrier appears
    await canvas.findByText("Messages below will be removed when you submit");
  },
  parameters: {
    docs: {
      description: {
        story:
          "Shows the editing message state with the amber-styled input border and edit cutoff barrier indicating messages that will be removed.",
      },
    },
  },
};
