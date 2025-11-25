import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ThinkingSliderComponent } from "./ThinkingSlider";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";

const meta = {
  title: "Components/ThinkingSlider",
  component: ThinkingSliderComponent,
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
  tags: ["autodocs"],
  argTypes: {
    modelString: {
      control: "text",
      description: "Model name that determines thinking policy",
    },
  },
  args: {
    modelString: "anthropic:claude-sonnete-4-5",
  },
  decorators: [
    (Story) => (
      <ThinkingProvider workspaceId="storybook-demo">
        <Story />
      </ThinkingProvider>
    ),
  ],
} satisfies Meta<typeof ThinkingSliderComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const DifferentModels: Story = {
  render: () => (
    <div className="bg-dark flex min-w-80 flex-col gap-[30px] p-10">
      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">
          Claude Sonnet 4.5 (4 levels)
        </div>
        <ThinkingSliderComponent modelString="anthropic:claude-sonnete-4-5" />
      </div>

      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">
          Claude Opus 4.5 (3 levels: low/medium/high)
        </div>
        <ThinkingSliderComponent modelString="anthropic:claude-opus-4-5" />
      </div>

      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">Claude Opus 4.1 (4 levels)</div>
        <ThinkingSliderComponent modelString="anthropic:claude-opus-4-1" />
      </div>

      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">
          Gemini 3 (2 levels: low/high)
        </div>
        <ThinkingSliderComponent modelString="google:gemini-3-pro-preview" />
      </div>

      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">GPT-5 Codex (4 levels)</div>
        <ThinkingSliderComponent modelString="openai:gpt-5-codex" />
      </div>
    </div>
  ),
};

export const InteractiveDemo: Story = {
  // Use unique workspaceId to isolate state from other stories
  decorators: [
    (Story) => (
      <ThinkingProvider workspaceId="storybook-interactive-demo">
        <Story />
      </ThinkingProvider>
    ),
  ],
  render: () => (
    <div className="bg-dark flex min-w-80 flex-col gap-[30px] p-10">
      <div className="text-bright font-primary mb-2.5 text-[13px]">
        Try moving the slider to see the purple glow effect intensify:
      </div>
      <ThinkingSliderComponent modelString="claude-3-5-sonnet-20241022" />
      <div className="text-muted-light font-primary mt-2.5 text-[11px]">
        • <strong>Off</strong>: No thinking (gray)
        <br />• <strong>Low</strong>: Minimal thinking (light purple)
        <br />• <strong>Medium</strong>: Moderate thinking (purple)
        <br />• <strong>High</strong>: Maximum thinking (bright purple)
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Find the slider
    const slider = canvas.getByRole("slider");

    // Verify slider is present and accessible
    await expect(slider).toBeInTheDocument();
    await expect(slider).toHaveAttribute("type", "range");

    // Initial state should be "off" (value 0)
    await expect(slider).toHaveAttribute("aria-valuenow", "0");
    await expect(slider).toHaveAttribute("aria-valuetext", "off");

    // Note: Testing actual slider interaction via keyboard/mouse is complex
    // The important part is that the slider is accessible and has correct initial state
  },
};

export const Opus45ThreeLevels: Story = {
  args: { modelString: "anthropic:claude-opus-4-5" },
  render: (args) => (
    <div className="bg-dark flex min-w-80 flex-col gap-[30px] p-10">
      <div className="text-bright font-primary mb-2.5 text-[13px]">
        Claude Opus 4.5 uses the effort parameter (low/medium/high only, no &ldquo;off&rdquo;):
      </div>
      <ThinkingSliderComponent modelString={args.modelString} />
      <div className="text-muted-light font-primary mt-2.5 text-[11px]">
        • <strong>Low</strong>: Conservative token usage
        <br />• <strong>Medium</strong>: Balanced usage (default)
        <br />• <strong>High</strong>: Best results, more tokens
      </div>
    </div>
  ),
};

export const LockedThinking: Story = {
  args: { modelString: "openai:gpt-5-pro" },
  render: (args) => (
    <div className="bg-dark flex min-w-80 flex-col gap-[30px] p-10">
      <div className="text-bright font-primary mb-2.5 text-[13px]">
        Some models have locked thinking levels based on their capabilities:
      </div>
      <div>
        <div className="text-muted-light font-primary mb-2 text-xs">
          GPT-5-Pro (locked to &ldquo;high&rdquo;)
        </div>
        <ThinkingSliderComponent modelString={args.modelString} />
      </div>
      <div className="text-muted-light font-primary mt-2.5 text-[11px]">
        Hover over the locked indicator to see why it&apos;s fixed.
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // Find the level text using aria-label (should be "high" and fixed)
    const levelDisplay = canvasElement.querySelector('[aria-label*="Thinking level fixed"]');
    await expect(levelDisplay).toBeInTheDocument();
    await expect(levelDisplay).toHaveTextContent("high");

    // Verify it's a fixed level (no slider present)
    const slider = canvas.queryByRole("slider");
    await expect(slider).not.toBeInTheDocument();

    // Test passes if we verified the fixed level and no slider
    // Tooltip test is skipped as it's complex with nested structure
  },
};
