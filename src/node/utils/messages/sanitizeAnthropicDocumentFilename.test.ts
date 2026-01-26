import { describe, it, expect } from "bun:test";
import {
  sanitizeAnthropicDocumentFilename,
  sanitizeAnthropicPdfFilenames,
} from "./sanitizeAnthropicDocumentFilename";
import type { MuxMessage } from "@/common/types/message";

describe("sanitizeAnthropicDocumentFilename", () => {
  it("replaces periods with spaces", () => {
    expect(sanitizeAnthropicDocumentFilename("file.pdf")).toBe("file pdf");
    expect(sanitizeAnthropicDocumentFilename("report.v2.pdf")).toBe("report v2 pdf");
  });

  it("preserves allowed characters", () => {
    expect(sanitizeAnthropicDocumentFilename("my-file")).toBe("my-file");
    expect(sanitizeAnthropicDocumentFilename("file (1)")).toBe("file (1)");
    expect(sanitizeAnthropicDocumentFilename("file [draft]")).toBe("file [draft]");
    expect(sanitizeAnthropicDocumentFilename("Document 2024")).toBe("Document 2024");
  });

  it("replaces underscores with spaces", () => {
    expect(sanitizeAnthropicDocumentFilename("my_file_name")).toBe("my file name");
  });

  it("collapses consecutive whitespace", () => {
    expect(sanitizeAnthropicDocumentFilename("file...name")).toBe("file name");
    expect(sanitizeAnthropicDocumentFilename("a  b  c")).toBe("a b c");
    expect(sanitizeAnthropicDocumentFilename("file___name")).toBe("file name");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeAnthropicDocumentFilename(".file.")).toBe("file");
    expect(sanitizeAnthropicDocumentFilename("  spaced  ")).toBe("spaced");
  });

  it("returns fallback for undefined input", () => {
    expect(sanitizeAnthropicDocumentFilename(undefined)).toBe("Document");
    expect(sanitizeAnthropicDocumentFilename(undefined, "PDF")).toBe("PDF");
  });

  it("returns fallback for empty result after sanitization", () => {
    expect(sanitizeAnthropicDocumentFilename("...")).toBe("Document");
    expect(sanitizeAnthropicDocumentFilename("___", "Attachment")).toBe("Attachment");
  });

  it("handles realistic filenames from the reported issue", () => {
    // Original filename that triggered the error
    expect(sanitizeAnthropicDocumentFilename("D19910350Lj.pdf")).toBe("D19910350Lj pdf");
  });
});

describe("sanitizeAnthropicPdfFilenames", () => {
  const createUserMessageWithPdf = (filename: string): MuxMessage => ({
    id: "msg-1",
    role: "user",
    parts: [
      { type: "text", text: "Check this document" },
      {
        type: "file",
        url: "data:application/pdf;base64,JVBERi0...",
        mediaType: "application/pdf",
        filename,
      },
    ],
  });

  it("sanitizes PDF filenames in user messages", () => {
    const messages: MuxMessage[] = [createUserMessageWithPdf("report.pdf")];

    const result = sanitizeAnthropicPdfFilenames(messages);

    expect(result[0].parts[1]).toEqual({
      type: "file",
      url: "data:application/pdf;base64,JVBERi0...",
      mediaType: "application/pdf",
      filename: "report pdf",
    });
  });

  it("does not mutate original messages", () => {
    const messages: MuxMessage[] = [createUserMessageWithPdf("original.pdf")];
    const originalFilename = (messages[0].parts[1] as { filename: string }).filename;

    sanitizeAnthropicPdfFilenames(messages);

    expect((messages[0].parts[1] as { filename: string }).filename).toBe(originalFilename);
  });

  it("passes through assistant messages unchanged", () => {
    const assistantMessage: MuxMessage = {
      id: "msg-2",
      role: "assistant",
      parts: [{ type: "text", text: "Response" }],
    };

    const result = sanitizeAnthropicPdfFilenames([assistantMessage]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(assistantMessage); // Same reference
  });

  it("does not sanitize non-PDF files", () => {
    const imageMessage: MuxMessage = {
      id: "msg-3",
      role: "user",
      parts: [
        {
          type: "file",
          url: "data:image/png;base64,...",
          mediaType: "image/png",
          filename: "screenshot.png",
        },
      ],
    };

    const result = sanitizeAnthropicPdfFilenames([imageMessage]);

    expect(result[0]).toBe(imageMessage); // Same reference - no change
  });

  it("handles case-insensitive media type matching", () => {
    const messages: MuxMessage[] = [
      {
        id: "msg-4",
        role: "user",
        parts: [
          {
            type: "file",
            url: "data:application/pdf;base64,...",
            mediaType: "APPLICATION/PDF", // uppercase
            filename: "test.pdf",
          },
        ],
      },
    ];

    const result = sanitizeAnthropicPdfFilenames(messages);

    expect((result[0].parts[0] as { filename: string }).filename).toBe("test pdf");
  });

  it("returns original array if no changes needed", () => {
    const messages: MuxMessage[] = [
      {
        id: "msg-5",
        role: "user",
        parts: [{ type: "text", text: "No attachments here" }],
      },
    ];

    const result = sanitizeAnthropicPdfFilenames(messages);

    expect(result).toBe(messages); // Same array reference
  });
});
