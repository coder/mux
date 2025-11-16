import type { Meta, StoryObj } from "@storybook/react-vite";
import { action } from "storybook/actions";
import { expect, userEvent, waitFor } from "storybook/test";
import { useState } from "react";
import {
  Modal,
  ModalActions,
  PrimaryButton,
  CancelButton,
  DangerButton,
  ModalInfo,
  WarningBox,
  WarningTitle,
  WarningText,
} from "./Modal";

const meta = {
  title: "Components/Modal",
  component: Modal,
  parameters: {
    layout: "fullscreen",
    controls: {
      exclude: ["onClose"],
    },
  },
  tags: ["autodocs"],
  argTypes: {
    title: {
      control: "text",
      description: "Modal title",
    },
    subtitle: {
      control: "text",
      description: "Optional subtitle",
    },
    isOpen: {
      control: "boolean",
      description: "Whether the modal is visible",
    },
    isLoading: {
      control: "boolean",
      description: "Disables closing when true",
    },
    maxWidth: {
      control: "text",
      description: "Maximum width (e.g., '500px', '800px')",
    },
    maxHeight: {
      control: "text",
      description: "Maximum height (e.g., '400px', '80vh')",
    },
    children: {
      control: false, // Disable controls for children to avoid serialization issues
    },
    onClose: {
      control: false,
      action: "onClose",
    },
  },
  args: {
    onClose: () => {
      // No-op for Storybook - in real app this closes the modal
    },
    isOpen: true,
  },
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Basic: Story = {
  args: {
    title: "Basic Modal",
    children: (
      <>
        <p>This is a basic modal with some content.</p>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <PrimaryButton onClick={action("confirm-clicked")}>Confirm</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
};

export const WithSubtitle: Story = {
  args: {
    title: "Create New Workspace",
    subtitle: "Enter a name for your new workspace",
    children: (
      <>
        <p>This modal includes a subtitle below the title.</p>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <PrimaryButton onClick={action("ok-clicked")}>OK</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
};

export const WithInfoBox: Story = {
  args: {
    title: "Confirm Action",
    children: (
      <>
        <ModalInfo>
          <p>
            This operation will create a new workspace at <code>~/cmux/project/branch</code>
          </p>
          <p>Existing files will not be affected.</p>
        </ModalInfo>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <PrimaryButton onClick={action("create-clicked")}>Create</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
};

export const WithWarning: Story = {
  args: {
    title: "Delete Workspace",
    subtitle: "Are you sure?",
    children: (
      <>
        <WarningBox>
          <WarningTitle>Warning</WarningTitle>
          <WarningText>
            This action cannot be undone. All data will be permanently deleted.
          </WarningText>
        </WarningBox>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <DangerButton onClick={action("delete-clicked")}>Delete</DangerButton>
        </ModalActions>
      </>
    ),
  },
};

export const Loading: Story = {
  args: {
    title: "Please Wait",
    isLoading: true,
    children: (
      <>
        <p>Processing your request...</p>
        <ModalActions>
          <CancelButton disabled>Cancel</CancelButton>
          <PrimaryButton disabled>Confirm</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
};

export const WideModal: Story = {
  args: {
    title: "Wide Modal Example",
    maxWidth: "800px",
    children: (
      <>
        <p>This modal has a wider maximum width to accommodate more content.</p>
        <ModalInfo>
          <p>
            You can customize the modal width by passing the <code>maxWidth</code> prop.
          </p>
        </ModalInfo>
        <ModalActions>
          <CancelButton onClick={action("close-clicked")}>Close</CancelButton>
        </ModalActions>
      </>
    ),
  },
};

// Interactive test stories
export const EscapeKeyCloses: Story = {
  args: {
    title: "Press Escape to Close",
    children: (
      <>
        <p>Try pressing the Escape key to close this modal.</p>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <PrimaryButton onClick={action("ok-clicked")}>OK</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(true);

    return (
      <>
        {!isOpen && <div style={{ padding: "20px", color: "#cccccc" }}>Modal was closed! ✓</div>}
        <Modal {...args} isOpen={isOpen} onClose={() => setIsOpen(false)} />
      </>
    );
  },
  play: async () => {
    // Modal is initially open
    const modal = document.querySelector('[role="dialog"]');
    await expect(modal).toBeInTheDocument();

    // Wait for modal to be fully mounted and event listeners attached
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Press Escape key
    await userEvent.keyboard("{Escape}");

    // Wait for modal to be removed from DOM
    await waitFor(async () => {
      const closedModal = document.querySelector('[role="dialog"]');
      await expect(closedModal).not.toBeInTheDocument();
    });
  },
};

export const OverlayClickCloses: Story = {
  args: {
    title: "Click Overlay to Close",
    children: (
      <>
        <p>Click outside this modal (on the dark overlay) to close it.</p>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
        </ModalActions>
      </>
    ),
  },
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(true);

    return (
      <>
        {!isOpen && <div style={{ padding: "20px", color: "#cccccc" }}>Modal was closed! ✓</div>}
        <Modal {...args} isOpen={isOpen} onClose={() => setIsOpen(false)} />
      </>
    );
  },
  play: async () => {
    // Modal is initially open
    const modal = document.querySelector('[role="dialog"]');
    await expect(modal).toBeInTheDocument();

    // Wait for modal to be fully mounted and event listeners attached
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Click on overlay (role="presentation")
    const overlay = document.querySelector('[role="presentation"]');
    await expect(overlay).toBeInTheDocument();
    await userEvent.click(overlay!);

    // Wait for modal to be removed from DOM
    await waitFor(async () => {
      const closedModal = document.querySelector('[role="dialog"]');
      await expect(closedModal).not.toBeInTheDocument();
    });
  },
};

export const ContentClickDoesNotClose: Story = {
  args: {
    title: "Click Inside Modal",
    children: (
      <>
        <p>Clicking inside the modal content should not close it.</p>
        <ModalActions>
          <CancelButton onClick={action("cancel-clicked")}>Cancel</CancelButton>
          <PrimaryButton onClick={action("ok-clicked")}>OK</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(true);

    return (
      <>
        {!isOpen && <div style={{ padding: "20px", color: "#cccccc" }}>Modal was closed!</div>}
        <Modal {...args} isOpen={isOpen} onClose={() => setIsOpen(false)} />
      </>
    );
  },
  play: async () => {
    // Modal is initially open
    const modal = document.querySelector('[role="dialog"]');
    await expect(modal).toBeInTheDocument();

    // Click on the modal content itself
    await userEvent.click(modal!);

    // Give time for any potential state change
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Modal should still be open
    const stillOpenModal = document.querySelector('[role="dialog"]');
    await expect(stillOpenModal).toBeInTheDocument();
  },
};

export const LoadingPreventsClose: Story = {
  args: {
    title: "Loading State",
    isLoading: true,
    children: (
      <>
        <p>This modal cannot be closed while loading.</p>
        <ModalActions>
          <CancelButton disabled>Cancel</CancelButton>
          <PrimaryButton disabled>Processing...</PrimaryButton>
        </ModalActions>
      </>
    ),
  },
  render: function Render(args) {
    const [isOpen, setIsOpen] = useState(true);

    return <Modal {...args} isOpen={isOpen} onClose={() => setIsOpen(false)} />;
  },
  play: async () => {
    // Modal is initially open
    const modal = document.querySelector('[role="dialog"]');
    await expect(modal).toBeInTheDocument();

    // Try to press Escape (should not work due to isLoading=true)
    await userEvent.keyboard("{Escape}");

    // Give time for any potential state change
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Modal should still be open
    const stillOpenModal1 = document.querySelector('[role="dialog"]');
    await expect(stillOpenModal1).toBeInTheDocument();

    // Try to click overlay (should also not work)
    const overlay = document.querySelector('[role="presentation"]');
    await userEvent.click(overlay!);

    // Give time for any potential state change
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Modal should still be open
    const stillOpenModal2 = document.querySelector('[role="dialog"]');
    await expect(stillOpenModal2).toBeInTheDocument();
  },
};
