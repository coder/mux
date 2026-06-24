import type { Meta, StoryObj } from "@storybook/react-vite";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { Button } from "../Button/Button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  WarningBox,
  WarningText,
  WarningTitle,
} from "./Dialog.js";

// Modal dialog primitive (Radix-backed) plus its content building blocks
// (header/title/description/footer, warning box). Rendered with defaultOpen so
// the dialog surface is visible while staying dismissable in Storybook.
const meta: Meta<typeof Dialog> = {
  ...lightweightMeta,
  title: "Components/Dialog",
  component: Dialog,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="bg-background min-h-screen">
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
            <DialogDescription>
              Give this workspace a name that describes the work happening in it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ),
};

export const Destructive: Story = {
  render: () => (
    <div className="bg-background min-h-screen">
      <Dialog defaultOpen>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>This action cannot be undone.</DialogDescription>
          </DialogHeader>
          <WarningBox>
            <WarningTitle>This permanently deletes the project</WarningTitle>
            <WarningText>
              All workspaces, worktrees, and chat history for this project will be removed from
              disk.
            </WarningText>
          </WarningBox>
          <DialogFooter>
            <Button variant="ghost">Cancel</Button>
            <Button variant="destructive">Delete project</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  ),
};
