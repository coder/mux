import type { ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
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
