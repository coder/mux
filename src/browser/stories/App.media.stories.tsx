/**
 * Media content stories (images)
 *
 * Tests image rendering in chat messages: multi-image galleries, diverse
 * image formats/sizes, and single-image layout.
 */

import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { UserMessageContent } from "@/browser/features/Messages/UserMessageContent";
import type { FilePart } from "@/common/orpc/schemas";
import { lightweightMeta } from "./meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Media",
  component: UserMessageContent,
} satisfies Meta<typeof UserMessageContent>;

export default meta;

type Story = StoryObj<typeof meta>;

// ─── Placeholder images for stable visual testing ────────────────────────────
// Each variant has a distinct size and color so they're visually distinguishable
// in stories without relying on real image assets.

/** Generic small image (200×150, dark gray) */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%23374151' width='200' height='150'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3EImage%3C/text%3E%3C/svg%3E";

/** Wide screenshot (400×300, dark bg with monitor-like label) */
const PLACEHOLDER_SCREENSHOT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%231f2937' width='400' height='300'/%3E%3Crect fill='%23374151' x='20' y='20' width='360' height='260' rx='4'/%3E%3Ctext fill='%236b7280' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='14'%3EScreenshot 400%C3%97300%3C/text%3E%3C/svg%3E";

/** Square diagram (300×300, blue-ish bg) */
const PLACEHOLDER_DIAGRAM =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%231e3a5f' width='300' height='300'/%3E%3Crect fill='%23264b73' x='30' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='170' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='100' y='200' width='100' height='60' rx='4'/%3E%3Cline x1='130' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Cline x1='170' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Ctext fill='%237eb8da' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='13'%3EDiagram 300%C3%97300%3C/text%3E%3C/svg%3E";

/** Small photo (200×150, green-ish bg) */
const PLACEHOLDER_PHOTO =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%231a3a2a' width='200' height='150'/%3E%3Ccircle cx='150' cy='40' r='20' fill='%232d5a3e'/%3E%3Cpolygon points='0,150 80,60 200,150' fill='%23265e3a'/%3E%3Ctext fill='%2388c9a0' x='50%25' y='40%25' text-anchor='middle' dy='.3em' font-size='12'%3EPhoto 200%C3%97150%3C/text%3E%3C/svg%3E";

const bugReportFileParts: FilePart[] = [
  {
    url: PLACEHOLDER_SCREENSHOT,
    mediaType: "image/svg+xml",
    filename: "modal-regression-full-page.svg",
  },
  {
    url: PLACEHOLDER_IMAGE,
    mediaType: "image/svg+xml",
    filename: "modal-regression-close-up.svg",
  },
];

const diverseImageFileParts: FilePart[] = [
  {
    url: PLACEHOLDER_SCREENSHOT,
    mediaType: "image/svg+xml",
    filename: "notification-ui-current.svg",
  },
  {
    url: PLACEHOLDER_DIAGRAM,
    mediaType: "image/svg+xml",
    filename: "notification-architecture.svg",
  },
  {
    url: PLACEHOLDER_PHOTO,
    mediaType: "image/svg+xml",
    filename: "notification-reference-photo.svg",
  },
];

const singleDiagramFileParts: FilePart[] = [
  {
    url: PLACEHOLDER_DIAGRAM,
    mediaType: "image/svg+xml",
    filename: "system-architecture-diagram.svg",
  },
];

function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

// ─── Stories ─────────────────────────────────────────────────────────────────

/** Multi-image bug report screenshot set */
export const MessageWithImages: Story = {
  render: () => (
    <StoryLayout>
      <UserMessageContent
        variant="sent"
        content="Here's what it looks like after the fix — full page and a close-up of the modal."
        fileParts={bugReportFileParts}
      />
    </StoryLayout>
  ),
};

/** Diverse image references — screenshot, architecture diagram, and photo */
export const MultipleImageFormats: Story = {
  render: () => (
    <StoryLayout>
      <UserMessageContent
        variant="sent"
        content="I'm trying to redesign our notification system. Here's the current UI, the architecture diagram, and a reference photo from a design I liked."
        fileParts={diverseImageFileParts}
      />
    </StoryLayout>
  ),
};

/** Single large image — tests the non-gallery (single-image) layout path */
export const SingleLargeImage: Story = {
  render: () => (
    <StoryLayout>
      <UserMessageContent
        variant="sent"
        content="Can you review this architecture diagram? I want to make sure the data flow between the API gateway and the worker pool makes sense."
        fileParts={singleDiagramFileParts}
      />
    </StoryLayout>
  ),
};
