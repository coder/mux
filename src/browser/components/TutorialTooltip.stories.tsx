import type { Meta, StoryObj } from "@storybook/react-vite";
import { TutorialTooltip, type TutorialStep } from "./TutorialTooltip";
import { TutorialProvider } from "@/browser/contexts/TutorialContext";
import { TUTORIAL_STATE_KEY, type TutorialState } from "@/common/constants/storage";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

const meta = {
  title: "Components/TutorialTooltip",
  component: TutorialTooltip,
  parameters: {
    layout: "centered",
    // Enable tutorials for these stories
    tutorialEnabled: true,
  },
  tags: ["autodocs"],
  decorators: [
    (Story) => {
      // Reset tutorial state to not-disabled for these stories
      const enabledState: TutorialState = {
        disabled: false,
        completed: {},
      };
      localStorage.setItem(TUTORIAL_STATE_KEY, JSON.stringify(enabledState));

      return (
        <TutorialProvider>
          <Story />
        </TutorialProvider>
      );
    },
  ],
} satisfies Meta<typeof TutorialTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mock target element for positioning
const MockTargetWrapper: React.FC<{
  children: React.ReactNode;
  tutorialTarget: string;
}> = ({ children, tutorialTarget }) => (
  <div className="bg-background flex h-[400px] w-[600px] items-center justify-center">
    <button
      data-tutorial={tutorialTarget}
      className="bg-accent rounded px-4 py-2 text-sm text-white"
    >
      Target Element
    </button>
    {children}
  </div>
);

const sampleStep: TutorialStep = {
  target: "demo-target",
  title: "Welcome to Mux",
  content: "This is a tutorial tooltip that helps guide users through the application.",
  position: "bottom",
};

export const SingleStep: Story = {
  args: {
    step: sampleStep,
    currentStep: 1,
    totalSteps: 1,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <MockTargetWrapper tutorialTarget="demo-target">
      <TutorialTooltip {...args} />
    </MockTargetWrapper>
  ),
};

export const MultiStepFirst: Story = {
  args: {
    step: {
      target: "demo-target",
      title: "Choose Your Model",
      content:
        "Select which AI model to use. Different models have different capabilities and costs.",
      position: "bottom",
    },
    currentStep: 1,
    totalSteps: 4,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <MockTargetWrapper tutorialTarget="demo-target">
      <TutorialTooltip {...args} />
    </MockTargetWrapper>
  ),
};

export const MultiStepMiddle: Story = {
  args: {
    step: {
      target: "demo-target",
      title: "Exec vs Plan Mode",
      content:
        "Exec mode lets the AI edit files and run commands. Plan mode is read-only—great for exploring ideas safely.",
      position: "top",
    },
    currentStep: 2,
    totalSteps: 4,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <MockTargetWrapper tutorialTarget="demo-target">
      <TutorialTooltip {...args} />
    </MockTargetWrapper>
  ),
};

export const MultiStepLast: Story = {
  args: {
    step: {
      target: "demo-target",
      title: "Runtime Environment",
      content: "Run locally using git worktrees, or connect via SSH to work on a remote machine.",
      position: "bottom",
    },
    currentStep: 4,
    totalSteps: 4,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <MockTargetWrapper tutorialTarget="demo-target">
      <TutorialTooltip {...args} />
    </MockTargetWrapper>
  ),
};

// Position variants
const PositionWrapper: React.FC<{
  children: React.ReactNode;
  tutorialTarget: string;
  position: "center" | "top" | "bottom" | "left" | "right";
}> = ({ children, tutorialTarget, position }) => {
  const positionClasses = {
    center: "items-center justify-center",
    top: "items-start justify-center pt-20",
    bottom: "items-end justify-center pb-20",
    left: "items-center justify-start pl-20",
    right: "items-center justify-end pr-20",
  };

  return (
    <div className={`bg-background flex h-[400px] w-[600px] ${positionClasses[position]}`}>
      <button
        data-tutorial={tutorialTarget}
        className="bg-accent rounded px-4 py-2 text-sm text-white"
      >
        Target
      </button>
      {children}
    </div>
  );
};

export const PositionBottom: Story = {
  args: {
    step: { ...sampleStep, position: "bottom" },
    currentStep: 1,
    totalSteps: 1,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <PositionWrapper tutorialTarget="demo-target" position="top">
      <TutorialTooltip {...args} />
    </PositionWrapper>
  ),
};

export const PositionTop: Story = {
  args: {
    step: { ...sampleStep, position: "top" },
    currentStep: 1,
    totalSteps: 1,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <PositionWrapper tutorialTarget="demo-target" position="bottom">
      <TutorialTooltip {...args} />
    </PositionWrapper>
  ),
};

export const PositionLeft: Story = {
  args: {
    step: { ...sampleStep, position: "left" },
    currentStep: 1,
    totalSteps: 1,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <PositionWrapper tutorialTarget="demo-target" position="right">
      <TutorialTooltip {...args} />
    </PositionWrapper>
  ),
};

export const PositionRight: Story = {
  args: {
    step: { ...sampleStep, position: "right" },
    currentStep: 1,
    totalSteps: 1,
    onNext: noop,
    onDismiss: noop,
    onDisableTutorial: noop,
  },
  render: (args) => (
    <PositionWrapper tutorialTarget="demo-target" position="left">
      <TutorialTooltip {...args} />
    </PositionWrapper>
  ),
};
