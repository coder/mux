import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { fireEvent, waitFor, within } from "@storybook/test";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { AttachFileToolCall } from "@/browser/features/Tools/AttachFileToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/AttachFile",
  component: AttachFileToolCall,
} satisfies Meta<typeof AttachFileToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const samplePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const sampleBytes = "ZGlzcGxheS1vbmx5IGZpbGU=";

function createAttachFileResult(file: ReturnType<typeof createDisplayOnlyFilePart>) {
  return {
    type: "content",
    value: [
      {
        type: "text",
        text: `[File shown to user: ${file.filename ?? file.mediaType}]`,
      },
      file,
    ],
  };
}

function ToolStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-2xl">{props.children}</div>
    </div>
  );
}

function GallerySection(props: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.label}
      </div>
      {props.children}
    </section>
  );
}

// Gallery composite: folds the non-interactive "completed" attachment variants
// (image, video, audio, markdown, generic file) into a single snapshot to keep
// the snapshot budget low while preserving every distinct visual state.
export const Gallery: Story = {
  parameters: {
    pixel: {
      // Chromium's native media controls contain an internal loading spinner whose frame is not
      // controlled by page CSS. Mask only those controls; the surrounding attachment UI remains
      // under visual regression coverage.
      mask: [{ selector: "video, audio" }],
    },
  },
  render: () => (
    <ToolStoryShell>
      <div className="flex flex-col gap-6">
        <GallerySection label="Image attachment">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "screenshot.png" }}
            result={{
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: screenshot.png]" },
                {
                  type: "media",
                  data: samplePng,
                  mediaType: "image/png",
                  filename: "screenshot.png",
                },
              ],
            }}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only video">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "recording.webm" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "video/webm",
                filename: "recording.webm",
                size: 17_408,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only audio">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "voice-note.mp3" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "audio/mpeg",
                filename: "voice-note.mp3",
                size: 8_192,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only markdown">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "release-notes.md" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: "IyBSZWxlYXNlIE5vdGVzCgotIEFkZGVkICoqbWFya2Rvd24qKiBwcmV2aWV3Lgo=",
                mediaType: "text/markdown",
                filename: "release-notes.md",
                size: 47,
              })
            )}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="PDF attachment (download card)">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "quarterly-report.pdf" }}
            result={{
              type: "content",
              value: [
                { type: "text", text: "[Attachment prepared: quarterly-report.pdf]" },
                {
                  type: "media",
                  data: sampleBytes,
                  mediaType: "application/pdf",
                  filename: "quarterly-report.pdf",
                },
              ],
            }}
            status="completed"
          />
        </GallerySection>
        <GallerySection label="Display-only generic file">
          <AttachFileToolCall
            toolName="attach_file"
            args={{ path: "archive.zip", filename: "support-bundle.zip" }}
            result={createAttachFileResult(
              createDisplayOnlyFilePart({
                data: sampleBytes,
                mediaType: "application/octet-stream",
                filename: "support-bundle.zip",
                size: 524_288,
              })
            )}
            status="completed"
          />
        </GallerySection>
      </div>
    </ToolStoryShell>
  ),
};

// Right-click on an image thumbnail opens a context menu with view/copy/download
// actions. The play function opens the menu so the Pixel snapshot captures it.
export const ImageContextMenu: Story = {
  render: () => (
    <ToolStoryShell>
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "screenshot.png" }}
        result={{
          type: "content",
          value: [
            { type: "text", text: "[Attachment prepared: screenshot.png]" },
            {
              type: "media",
              data: samplePng,
              mediaType: "image/png",
              filename: "screenshot.png",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const image = await canvas.findByRole("img", { name: "screenshot.png" });

    // Fixed coordinates keep the menu position deterministic for snapshots.
    await fireEvent.contextMenu(image, { clientX: 120, clientY: 160 });

    // The menu renders in a portal attached to document.body.
    const body = within(document.body);
    await waitFor(() => body.getByText("Copy image"));
    await waitFor(() => body.getByText("Download image"));
    await waitFor(() => body.getByText("View full size"));
  },
};

// Touch-only contract: a 500ms long-press on the thumbnail opens the same
// context menu. Pixel does not emulate touch (pointer: coarse never matches),
// so this play function exercises the touch path directly per the Storybook
// responsive/Pixel validation rule.
export const ImageLongPressMenu: Story = {
  render: () => (
    <ToolStoryShell>
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "screenshot.png" }}
        result={{
          type: "content",
          value: [
            { type: "text", text: "[Attachment prepared: screenshot.png]" },
            {
              type: "media",
              data: samplePng,
              mediaType: "image/png",
              filename: "screenshot.png",
            },
          ],
        }}
        status="completed"
      />
    </ToolStoryShell>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement);
    const image = await canvas.findByRole("img", { name: "screenshot.png" });

    // Start a touch and hold: the long-press timer opens the menu after 500ms.
    // Chromium's TouchEvent constructor requires real Touch instances (plain
    // objects throw). Fixed coordinates keep the menu position deterministic.
    const touch = new Touch({ identifier: 1, target: image, clientX: 120, clientY: 160 });
    await fireEvent.touchStart(image, { touches: [touch] });

    // The menu renders in a portal attached to document.body. waitFor polls
    // past the 500ms long-press threshold.
    const body = within(document.body);
    await waitFor(() => body.getByText("Copy image"), { timeout: 3000 });

    await fireEvent.touchEnd(image);

    // The click that follows a long-press must be suppressed: the lightbox
    // must not open on top of the context menu. The Radix popover menu itself
    // has role="dialog", so detect the lightbox by its (visually hidden) title.
    await fireEvent.click(image);
    await waitFor(() => {
      if (body.queryByText("Image Preview")) {
        throw new Error("Lightbox should not open after a long-press");
      }
    });
  },
};

export const FailedAttachment: Story = {
  render: () => (
    <ToolStoryShell>
      <AttachFileToolCall
        toolName="attach_file"
        args={{ path: "missing.webm" }}
        result={{ success: false, error: "File not found: /workspace/missing.webm" }}
        status="failed"
      />
    </ToolStoryShell>
  ),
};
