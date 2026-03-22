import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "@storybook/test";
import { lightweightMeta } from "@/browser/stories/meta.js";
import {
  mockCoderInfoAvailable,
  mockCoderInfoMissing,
  mockCoderInfoOutdated,
} from "@/browser/stories/mocks/coder";
import { RUNTIME_MODE } from "@/common/types/runtime";
import { RuntimeButtonGroup, type RuntimeButtonGroupProps } from "./CreationControls";

const BASE_ARGS = {
  value: RUNTIME_MODE.WORKTREE,
  defaultMode: RUNTIME_MODE.WORKTREE,
  onChange: fn(),
  onSetDefault: fn(),
  runtimeAvailabilityState: {
    status: "loaded",
    data: {
      local: { available: true },
      worktree: { available: true },
      ssh: { available: true },
      docker: { available: true },
      devcontainer: { available: true },
    },
  },
} satisfies RuntimeButtonGroupProps;

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Creation Controls",
  component: RuntimeButtonGroup,
  render: (args) => (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-64">
        <RuntimeButtonGroup {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof RuntimeButtonGroup>;

export default meta;

type Story = StoryObj<typeof meta>;

async function openWorkspaceTypeMenu(storyRoot: HTMLElement): Promise<void> {
  const canvas = within(storyRoot);
  const trigger = await canvas.findByLabelText("Workspace type", {}, { timeout: 10000 });
  await userEvent.click(trigger);
}

/** Coder option is visible and selectable when Coder CLI is available. */
export const CoderAvailable: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoAvailable,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    await within(document.body).findByRole("option", { name: /^Coder/i }, { timeout: 10000 });
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option is hidden when Coder CLI is missing. */
export const CoderNotAvailable: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoMissing,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    await within(document.body).findByRole("option", { name: /^SSH/i }, { timeout: 10000 });
    await expect(within(document.body).queryByRole("option", { name: /^Coder/i })).toBeNull();
    await userEvent.keyboard("{Escape}");
  },
};

/** Coder option remains visible but disabled when CLI version is outdated. */
export const CoderOutdated: Story = {
  args: {
    ...BASE_ARGS,
    coderInfo: mockCoderInfoOutdated,
  },
  play: async ({ canvasElement }) => {
    const storyRoot = document.getElementById("storybook-root") ?? canvasElement;

    await openWorkspaceTypeMenu(storyRoot);
    const coderOption = await within(document.body).findByRole(
      "option",
      { name: /^Coder/i },
      { timeout: 10000 }
    );

    await expect(coderOption).toHaveAttribute("aria-disabled", "true");
    await expect(coderOption).toHaveTextContent("2.20.0");
    await expect(coderOption).toHaveTextContent("2.25.0");
    await userEvent.keyboard("{Escape}");
  },
};
