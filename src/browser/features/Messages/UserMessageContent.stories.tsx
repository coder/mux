import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { FilePart } from "@/common/orpc/schemas";
import { UserMessageContent } from "./UserMessageContent";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Messages/UserMessageContent/Media",
  component: UserMessageContent,
} satisfies Meta<typeof UserMessageContent>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Generic small image (200×150, dark gray) */
const PLACEHOLDER_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='150'%3E%3Crect fill='%23374151' width='200' height='150'/%3E%3Ctext fill='%239CA3AF' x='50%25' y='50%25' text-anchor='middle' dy='.3em'%3EImage%3C/text%3E%3C/svg%3E";

/** Wide screenshot (400×300, dark bg with monitor-like label) */
const PLACEHOLDER_SCREENSHOT =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='300'%3E%3Crect fill='%231f2937' width='400' height='300'/%3E%3Crect fill='%23374151' x='20' y='20' width='360' height='260' rx='4'/%3E%3Ctext fill='%236b7280' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='14'%3EScreenshot 400%C3%97300%3C/text%3E%3C/svg%3E";

/** Square diagram (300×300, blue-ish bg) */
const PLACEHOLDER_DIAGRAM =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect fill='%231e3a5f' width='300' height='300'/%3E%3Crect fill='%23264b73' x='30' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='170' y='30' width='100' height='60' rx='4'/%3E%3Crect fill='%23264b73' x='100' y='200' width='100' height='60' rx='4'/%3E%3Cline x1='130' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Cline x1='170' y1='90' x2='150' y2='200' stroke='%234a90d9' stroke-width='2'/%3E%3Ctext fill='%237eb8da' x='50%25' y='50%25' text-anchor='middle' dy='.3em' font-size='13'%3EDiagram 300%C3%97300%3C/text%3E%3C/svg%3E";

function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

function makeCanvasDataUrl(
  mimeType: "image/png" | "image/jpeg" | "image/webp",
  color: string,
  label: string
): string {
  if (typeof document === "undefined") {
    return PLACEHOLDER_SCREENSHOT;
  }

  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 200;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return PLACEHOLDER_SCREENSHOT;
  }

  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = color;
  ctx.fillRect(20, 20, canvas.width - 40, canvas.height - 40);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "20px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);

  return canvas.toDataURL(mimeType);
}

const BUG_REPORT_FILE_PARTS: FilePart[] = [
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

const SINGLE_DIAGRAM_FILE_PARTS: FilePart[] = [
  {
    url: PLACEHOLDER_DIAGRAM,
    mediaType: "image/svg+xml",
    filename: "system-architecture-diagram.svg",
  },
];

/** Message with multiple image attachments */
export const MessageWithImages: Story = {
  render: () => (
    <StoryLayout>
      <UserMessageContent
        variant="sent"
        content="Here's what it looks like after the fix — full page and a close-up of the modal."
        fileParts={BUG_REPORT_FILE_PARTS}
      />
    </StoryLayout>
  ),
};

/** Gallery with mixed image mime types */
export const MultipleImageFormats: Story = {
  render: () => {
    const diverseImageFileParts: FilePart[] = [
      {
        url: makeCanvasDataUrl("image/png", "#334155", "PNG 320×200"),
        mediaType: "image/png",
        filename: "notification-ui-current.png",
      },
      {
        url: makeCanvasDataUrl("image/jpeg", "#1d4ed8", "JPEG 320×200"),
        mediaType: "image/jpeg",
        filename: "notification-reference-photo.jpg",
      },
      {
        url: makeCanvasDataUrl("image/webp", "#0f766e", "WEBP 320×200"),
        mediaType: "image/webp",
        filename: "notification-architecture.webp",
      },
    ];

    return (
      <StoryLayout>
        <UserMessageContent
          variant="sent"
          content="I'm comparing multiple image formats for the same UI artifact."
          fileParts={diverseImageFileParts}
        />
      </StoryLayout>
    );
  },
};

/** Single large image attachment */
export const SingleLargeImage: Story = {
  render: () => (
    <StoryLayout>
      <UserMessageContent
        variant="sent"
        content="Can you review this architecture diagram?"
        fileParts={SINGLE_DIAGRAM_FILE_PARTS}
      />
    </StoryLayout>
  ),
};
