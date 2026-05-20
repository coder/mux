import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { GlobalWindow } from "happy-dom";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { AttachFileToolCall } from "./AttachFileToolCall";

describe("AttachFileToolCall", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders display-only markdown files with preview and download", () => {
    const markdown = "# Release Notes\n\n- Added **markdown** preview.\n";
    const data = Buffer.from(markdown).toString("base64");

    const view = render(
      <TooltipProvider>
        <AttachFileToolCall
          toolName="attach_file"
          args={{ path: "release-notes.md" }}
          result={{
            type: "content",
            value: [
              { type: "text", text: "[File shown to user: release-notes.md]" },
              createDisplayOnlyFilePart({
                data,
                mediaType: "text/markdown",
                filename: "release-notes.md",
                size: Buffer.byteLength(markdown),
              }),
            ],
          }}
          status="completed"
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Release Notes/)).toBeTruthy();
    expect(view.getByText(/Added/)).toBeTruthy();
    expect(view.getByText(/Shown to the user only/)).toBeTruthy();

    const download = view.getByRole("link", { name: /Download/ });
    expect(download.getAttribute("download")).toBe("release-notes.md");
    expect(download.getAttribute("href")).toBe(`data:text/markdown;base64,${data}`);
  });
});
