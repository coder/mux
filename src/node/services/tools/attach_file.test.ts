import { describe, expect, it } from "bun:test";
import type { ToolExecutionOptions } from "ai";
import * as fs from "fs/promises";
import * as path from "path";
import { MAX_SVG_TEXT_CHARS } from "@/common/constants/imageAttachments";
import type { AttachFileToolResult } from "@/common/types/tools";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/readAttachmentFromPath";
import { createAttachFileTool } from "./attach_file";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolExecutionOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createTestAttachFileTool(cwd: string) {
  return createAttachFileTool(createTestToolConfig(cwd));
}

function expectSuccessfulAttachFileResult(
  result: AttachFileToolResult
): Extract<AttachFileToolResult, { type: "content" }> {
  if (
    typeof result !== "object" ||
    result === null ||
    !("type" in result) ||
    result.type !== "content"
  ) {
    throw new Error(`Expected attach_file success result, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe("attach_file tool", () => {
  it("attaches a relative PNG path inside the workspace", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(workspaceDir.path, "fixtures", "screenshot.png");
    const pngBytes = Buffer.from("png-bytes");
    await fs.mkdir(path.dirname(pngPath), { recursive: true });
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        { path: "fixtures/screenshot.png" },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: screenshot.png]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "screenshot.png",
    });
  });

  it("attaches an absolute PNG path outside the workspace", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    using externalDir = new TestTempDir("attach-file-external");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(externalDir.path, "outside.png");
    const pngBytes = Buffer.from("outside-png-bytes");
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!({ path: pngPath }, mockToolCallOptions)) as AttachFileToolResult
    );

    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "outside.png",
    });
  });

  it("attaches an absolute PDF path and preserves explicit overrides", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    using externalDir = new TestTempDir("attach-file-external");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pdfPath = path.join(externalDir.path, "report.bin");
    const pdfBytes = Buffer.from("%PDF-1.7\nhello\n");
    await fs.writeFile(pdfPath, pdfBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        {
          path: pdfPath,
          mediaType: "application/pdf; charset=utf-8",
          filename: "Quarterly Report.pdf",
        },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: Quarterly Report.pdf]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pdfBytes.toString("base64"),
      mediaType: "application/pdf",
      filename: "Quarterly Report.pdf",
    });
  });

  it("infers media type from the source path when filename override has no extension", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const pngPath = path.join(workspaceDir.path, "chart.png");
    const pngBytes = Buffer.from("chart-png-bytes");
    await fs.writeFile(pngPath, pngBytes);

    const result = expectSuccessfulAttachFileResult(
      (await tool.execute!(
        {
          path: "chart.png",
          filename: "Quarterly Report",
        },
        mockToolCallOptions
      )) as AttachFileToolResult
    );

    expect(result.value[0]).toEqual({
      type: "text",
      text: "[Attachment prepared: Quarterly Report]",
    });
    expect(result.value[1]).toEqual({
      type: "media",
      data: pngBytes.toString("base64"),
      mediaType: "image/png",
      filename: "Quarterly Report",
    });
  });

  it("rejects a missing file", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);

    const result = (await tool.execute!(
      { path: "missing.png" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `File not found: ${path.join(workspaceDir.path, "missing.png")}`,
    });
  });

  it("rejects a directory", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const dirPath = path.join(workspaceDir.path, "screenshots");
    await fs.mkdir(dirPath, { recursive: true });

    const result = (await tool.execute!(
      { path: dirPath },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `Path is a directory, not a file: ${dirPath}`,
    });
  });

  it("rejects an unsupported type", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const textPath = path.join(workspaceDir.path, "notes.txt");
    await fs.writeFile(textPath, "hello");

    const result = (await tool.execute!(
      { path: "notes.txt" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `Unsupported attachment type: ${textPath}`,
    });
  });

  it("rejects files over the size cap", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const largePath = path.join(workspaceDir.path, "huge.pdf");
    await fs.writeFile(largePath, Buffer.alloc(MAX_ATTACH_FILE_SIZE_BYTES + 1, 0x61));

    const result = (await tool.execute!(
      { path: "huge.pdf" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: "Attachment is too large (10.00MB). The maximum supported size is 10.00MB.",
    });
  });

  it("rejects oversized SVG text", async () => {
    using workspaceDir = new TestTempDir("attach-file-workspace");
    const tool = createTestAttachFileTool(workspaceDir.path);
    const svgPath = path.join(workspaceDir.path, "diagram.svg");
    await fs.writeFile(svgPath, `<svg>${"a".repeat(MAX_SVG_TEXT_CHARS + 1)}</svg>`);

    const result = (await tool.execute!(
      { path: "diagram.svg" },
      mockToolCallOptions
    )) as AttachFileToolResult;

    expect(result).toEqual({
      success: false,
      error: `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${(MAX_SVG_TEXT_CHARS + 12).toLocaleString()}).`,
    });
  });
});
