import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { lightweightMeta } from "@/browser/stories/meta.js";
import { ImageFileViewer } from "./ImageFileViewer";
import { TextFileViewer } from "./TextFileViewer";

const meta = {
  ...lightweightMeta,
  title: "App/RightSidebar/FileViewer",
  component: TextFileViewer,
} satisfies Meta<typeof TextFileViewer>;

export default meta;

type Story = StoryObj<typeof meta>;

function FileViewerCanvas(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="h-[520px] overflow-hidden rounded-md border border-[var(--color-border-medium)] bg-[var(--color-code-bg)]">
        {props.children}
      </div>
    </div>
  );
}

function FileViewerNotice(props: { message: string }) {
  return (
    <FileViewerCanvas>
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4">
        <AlertCircle className="text-muted h-8 w-8" />
        <p className="text-muted-foreground text-center text-sm">{props.message}</p>
      </div>
    </FileViewerCanvas>
  );
}

const SAMPLE_TEXT_CONTENT = [
  'import { useState } from "react";',
  "",
  "interface ButtonProps {",
  "  label: string;",
  "  onClick: () => void;",
  "}",
  "",
  "export function Button(props: ButtonProps) {",
  "  const [isHovered, setIsHovered] = useState(false);",
  "",
  "  return (",
  "    <button",
  "      onClick={props.onClick}",
  "      onMouseEnter={() => setIsHovered(true)}",
  "      onMouseLeave={() => setIsHovered(false)}",
  "    >",
  "      {props.label}",
  "    </button>",
  "  );",
  "}",
].join("\n");

const SAMPLE_TEXT_WITH_DIFF = [
  'import { useState } from "react";',
  "",
  "export function Button() {",
  "  const [isSaving, setIsSaving] = useState(false);",
  "",
  "  return <button disabled={isSaving}>Save</button>;",
  "}",
].join("\n");

const SAMPLE_DIFF = [
  "--- a/src/components/Button.tsx",
  "+++ b/src/components/Button.tsx",
  "@@ -1,5 +1,7 @@",
  ' import { useState } from "react";',
  " ",
  " export function Button() {",
  "-  return <button>Save</button>;",
  "+  const [isSaving, setIsSaving] = useState(false);",
  "+",
  "+  return <button disabled={isSaving}>Save</button>;",
  " }",
].join("\n");

const SMALL_IMAGE_BASE64 =
  "PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPSc1MTInIGhlaWdodD0nMzIwJyB2aWV3Qm94PScwIDAgNTEyIDMyMCc+PHJlY3Qgd2lkdGg9JzUxMicgaGVpZ2h0PSczMjAnIGZpbGw9JyMxZjI5MzcnLz48cmVjdCB4PScyNCcgeT0nMjQnIHdpZHRoPSc0NjQnIGhlaWdodD0nMjcyJyByeD0nMTInIGZpbGw9JyMzMzQxNTUnLz48dGV4dCB4PSc1MCUnIHk9JzUwJScgZG9taW5hbnQtYmFzZWxpbmU9J21pZGRsZScgdGV4dC1hbmNob3I9J21pZGRsZScgZmlsbD0nI2NiZDVlMScgZm9udC1zaXplPScyMic+UHJldmlldyA1MTJ4MzIwPC90ZXh0Pjwvc3ZnPg==";

const LARGE_IMAGE_BASE64 =
  "PHN2ZyB4bWxucz0naHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmcnIHdpZHRoPScxNjAwJyBoZWlnaHQ9JzkwMCcgdmlld0JveD0nMCAwIDE2MDAgOTAwJz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9J2cnIHgxPScwJyB4Mj0nMScgeTE9JzAnIHkyPScxJz48c3RvcCBvZmZzZXQ9JzAlJyBzdG9wLWNvbG9yPScjMWQ0ZWQ4Jy8+PHN0b3Agb2Zmc2V0PScxMDAlJyBzdG9wLWNvbG9yPScjMGYxNzJhJy8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PHJlY3Qgd2lkdGg9JzE2MDAnIGhlaWdodD0nOTAwJyBmaWxsPSd1cmwoI2cpJy8+PGNpcmNsZSBjeD0nMTIwMCcgY3k9JzI2MCcgcj0nMTgwJyBmaWxsPSdyZ2JhKDI1NSwyNTUsMjU1LDAuMSknLz48dGV4dCB4PSc1MCUnIHk9JzUwJScgZG9taW5hbnQtYmFzZWxpbmU9J21pZGRsZScgdGV4dC1hbmNob3I9J21pZGRsZScgZmlsbD0nI2UyZThmMCcgZm9udC1zaXplPSc2NCc+TGFyZ2UgRGlhZ3JhbSAxNjAweDkwMDwvdGV4dD48L3N2Zz4=";

/** Text file viewer without uncommitted changes */
export const TextFileView: Story = {
  args: {
    workspaceId: "ws-file-viewer-text",
    content: SAMPLE_TEXT_CONTENT,
    filePath: "src/components/Button.tsx",
    size: SAMPLE_TEXT_CONTENT.length,
    diff: null,
  },
  render: (args) => (
    <FileViewerCanvas>
      <TextFileViewer {...args} />
    </FileViewerCanvas>
  ),
};

/** Text file viewer with inline diff annotations */
export const DiffView: Story = {
  args: {
    workspaceId: "ws-file-viewer-diff",
    content: SAMPLE_TEXT_WITH_DIFF,
    filePath: "src/components/Button.tsx",
    size: SAMPLE_TEXT_WITH_DIFF.length,
    diff: SAMPLE_DIFF,
  },
  render: (args) => (
    <FileViewerCanvas>
      <TextFileViewer {...args} />
    </FileViewerCanvas>
  ),
};

/** Image file viewer */
export const ImageView: Story = {
  render: () => (
    <FileViewerCanvas>
      <ImageFileViewer
        base64={SMALL_IMAGE_BASE64}
        mimeType="image/svg+xml"
        size={6_200}
        filePath="assets/icon.svg"
      />
    </FileViewerCanvas>
  ),
};

/** Large image in viewer to exercise zoom controls */
export const LargeImageView: Story = {
  render: () => (
    <FileViewerCanvas>
      <ImageFileViewer
        base64={LARGE_IMAGE_BASE64}
        mimeType="image/svg+xml"
        size={22_800}
        filePath="docs/architecture.svg"
      />
    </FileViewerCanvas>
  ),
};

/** Binary file notice shown by FileViewerTab */
export const BinaryFileNotice: Story = {
  render: () => <FileViewerNotice message="Unable to display binary file" />,
};

/** Large-file notice shown when file exceeds display size limit */
export const LargeFileNotice: Story = {
  render: () => <FileViewerNotice message="File is too large to display. Maximum: 10 MB." />,
};
