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

export const ImageAttachment: Story = {
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
};

export const DisplayOnlyVideo: Story = {
  render: () => (
    <ToolStoryShell>
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
    </ToolStoryShell>
  ),
};

export const DisplayOnlyAudio: Story = {
  render: () => (
    <ToolStoryShell>
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
    </ToolStoryShell>
  ),
};

export const DisplayOnlyGenericFile: Story = {
  render: () => (
    <ToolStoryShell>
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
