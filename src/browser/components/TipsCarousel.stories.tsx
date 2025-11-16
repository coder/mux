import type { Meta, StoryObj } from "@storybook/react-vite";
import { TipsCarousel } from "./TipsCarousel";

const meta = {
  title: "Components/TipsCarousel",
  component: TipsCarousel,
  parameters: {
    layout: "centered",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
  tags: ["autodocs"],
  argTypes: {},
} satisfies Meta<typeof TipsCarousel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <TipsCarousel fixedTipIndex={0} />,
};

export const WithExplanation: Story = {
  render: () => (
    <div className="bg-dark flex min-w-96 flex-col gap-5 p-5">
      <div className="text-bright font-primary text-[13px]">
        Tips rotate automatically based on time. Hover to see the gradient effect:
      </div>
      <TipsCarousel fixedTipIndex={0} />
      <div className="text-muted-light font-primary text-[11px]">
        Tips change every hour to provide variety and convey UX information.
      </div>
    </div>
  ),
};

export const DebugControls: Story = {
  render: () => (
    <div className="bg-dark flex min-w-96 flex-col gap-5 p-5">
      <div className="text-bright font-primary text-[13px]">For debugging, you can use:</div>
      <TipsCarousel fixedTipIndex={1} />
      <div className="text-muted-light font-monospace bg-modal-bg rounded p-3 text-[11px]">
        <div>window.setTip(0) // Show first tip</div>
        <div>window.setTip(1) // Show second tip</div>
        <div>window.clearTip() // Return to auto-rotation</div>
      </div>
    </div>
  ),
};

export const InContext: Story = {
  render: () => {
    return (
      <div className="bg-separator border-border-light font-primary flex items-center gap-3 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-light text-[11px]">Workspace:</span>
          <span className="text-bright text-[11px]">main</span>
        </div>
        <div
          style={{
            flex: 1,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <TipsCarousel fixedTipIndex={0} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-light text-[11px]">Mode: Plan</span>
        </div>
      </div>
    );
  },
};
