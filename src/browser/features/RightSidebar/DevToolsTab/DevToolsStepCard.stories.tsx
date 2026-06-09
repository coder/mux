import { userEvent, waitFor, within } from "@storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { DevToolsStep } from "@/common/types/devtools";
import { CHROMATIC_SINGLE_MODE, StoryUiShell } from "@/browser/stories/meta";
import { DevToolsStepCard } from "./DevToolsStepCard";

const NARROW_DEBUG_CARD_WIDTH = 400;

const meta = {
  title: "Features/RightSidebar/DevToolsStepCard",
  component: DevToolsStepCard,
  parameters: {
    layout: "fullscreen",
    chromatic: {
      delay: 200,
      modes: CHROMATIC_SINGLE_MODE,
    },
  },
  decorators: [
    (Story) => (
      <StoryUiShell>
        <div className="bg-surface-primary text-foreground p-3">
          <div
            data-testid="narrow-debug-card"
            className="overflow-hidden"
            style={{ width: NARROW_DEBUG_CARD_WIDTH }}
          >
            <Story />
          </div>
        </div>
      </StoryUiShell>
    ),
  ],
} satisfies Meta<typeof DevToolsStepCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const debugStep: DevToolsStep = {
  id: "step-2",
  runId: "run-1",
  stepNumber: 2,
  type: "stream",
  modelId: "gemini-3.5-flash",
  provider: "google.generative-ai",
  startedAt: "2026-06-09T12:00:00.000Z",
  durationMs: 8400,
  input: {
    maxOutputTokens: 65_536,
    toolChoice: "auto",
    providerOptions: {
      google: {
        safetySettings: [{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }],
      },
    },
    tools: Array.from({ length: 26 }, (_, index) => ({
      name: `tool_${index + 1}`,
      description: "A tool available to the agent.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    })),
    prompt: [
      { role: "system", content: "You are Mux." },
      { role: "user", content: "Find the latest information about evaluations." },
      { role: "assistant", content: "I will search the web and summarize the results." },
      {
        role: "tool",
        content:
          "Search results included https://example.com/engineering/demystifying-evals-for-ai-agents",
      },
    ],
  },
  output: {
    finishReason: "SAFETY",
    reasoningParts: [
      {
        id: "reasoning-1",
        text: "Summarizing the request and selecting the best follow-up tool call.",
      },
    ],
    toolCalls: [
      {
        toolCallId: "tool-call-1",
        toolName: "server:GOOGLE_SEARCH_WEB",
        args: {
          query: "site:example.com engineering demystifying evals for ai agents",
        },
      },
    ],
    textParts: [
      {
        id: "text-1",
        text: "The provider blocked this response for safety policy reasons.",
      },
    ],
  },
  usage: {
    inputTokens: 14_450,
    outputTokens: 807,
    totalTokens: 15_257,
    raw: { promptTokenCount: 14_450, candidatesTokenCount: 807 },
  },
  error: null,
  rawRequest: {
    body: { model: "gemini-3.5-flash", tools: ["server:GOOGLE_SEARCH_WEB"] },
  },
  requestHeaders: null,
  responseHeaders: null,
  rawResponse: { finishReason: "SAFETY" },
  rawChunks: null,
};

export const NarrowExpanded: Story = {
  tags: ["devtools-overflow"],
  args: {
    step: debugStep,
    toolPolicy: Array.from({ length: 12 }, (_, index) => ({
      regex_match: `server:policy_${index + 1}`,
      action: index % 2 === 0 ? "enable" : "disable",
    })),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Step 2/ }));

    await waitFor(() => canvas.getByText("server:GOOGLE_SEARCH_WEB"));

    const container = canvas.getByTestId("narrow-debug-card");
    if (container.scrollWidth > container.clientWidth + 1) {
      throw new Error(
        `Debug step card overflowed narrow container by ${container.scrollWidth - container.clientWidth}px`
      );
    }
  },
};
