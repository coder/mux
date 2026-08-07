import { describe, expect, test } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CompletedMessagePart } from "@/common/types/stream";
import { createDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { materializeWorkspaceTurnAttachFileArtifacts } from "@/node/services/workspaceTurnAttachFileArtifacts";

function attachFilePart(args: {
  toolCallId: string;
  data: string;
  mediaType: string;
  filename?: string;
  displayOnly?: boolean;
  inputPath?: string;
}): CompletedMessagePart {
  const filePart = args.displayOnly
    ? createDisplayOnlyFilePart({
        data: args.data,
        mediaType: args.mediaType,
        filename: args.filename,
        size: Buffer.from(args.data, "base64").length,
      })
    : {
        type: "media" as const,
        data: args.data,
        mediaType: args.mediaType,
        ...(args.filename != null ? { filename: args.filename } : {}),
      };
  return {
    type: "dynamic-tool",
    toolCallId: args.toolCallId,
    toolName: "attach_file",
    input: { path: args.inputPath ?? "/remote/child/output.bin" },
    state: "output-available",
    output: {
      type: "content",
      value: [{ type: "text", text: "prepared" }, filePart],
    },
  };
}

describe("workspace-turn attach_file artifacts", () => {
  test("materializes exact media and display-only bytes from persisted tool outputs", async () => {
    const ownerSessionDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "workspace-turn-artifacts-")
    );
    const imageBytes = Buffer.from("image-bytes");
    const pdfBytes = Buffer.from("%PDF-exact-bytes");
    const displayBytes = Buffer.from("chart source\n");
    const parts: CompletedMessagePart[] = [
      attachFilePart({
        toolCallId: "call-image",
        data: imageBytes.toString("base64"),
        mediaType: "image/png",
        filename: "../../chart.png",
      }),
      attachFilePart({
        toolCallId: "call-pdf",
        data: pdfBytes.toString("base64"),
        mediaType: "application/pdf",
        filename: "report.pdf",
        inputPath: "/ssh-only/path/report.pdf",
      }),
      attachFilePart({
        toolCallId: "call-display",
        data: displayBytes.toString("base64"),
        mediaType: "text/markdown",
        filename: "notes.md",
        displayOnly: true,
        inputPath: "/container-only/path/notes.md",
      }),
      {
        type: "dynamic-tool",
        toolCallId: "call-failed",
        toolName: "attach_file",
        input: { path: "/remote/missing" },
        state: "output-available",
        output: { success: false, error: "missing" },
      },
      attachFilePart({
        toolCallId: "call-malformed",
        data: "not base64!",
        mediaType: "image/png",
      }),
      attachFilePart({
        toolCallId: "call-image",
        data: Buffer.from("duplicate").toString("base64"),
        mediaType: "image/png",
        filename: "duplicate.png",
      }),
    ];

    const descriptors = await materializeWorkspaceTurnAttachFileArtifacts({
      ownerSessionDir,
      handleId: "wst_artifacts",
      parts,
    });

    expect(descriptors).toHaveLength(3);
    expect(descriptors.map((artifact) => artifact.filename)).toEqual([
      "chart.png",
      "report.pdf",
      "notes.md",
    ]);
    expect(descriptors[2]).toMatchObject({
      mediaType: "text/markdown",
      displayOnly: true,
      sourceToolCallId: "call-display",
    });
    expect(await fsPromises.readFile(descriptors[0].path)).toEqual(imageBytes);
    expect(await fsPromises.readFile(descriptors[1].path)).toEqual(pdfBytes);
    expect(await fsPromises.readFile(descriptors[2].path)).toEqual(displayBytes);
    for (const descriptor of descriptors) {
      expect(descriptor.path.startsWith(path.join(ownerSessionDir, "task-artifacts"))).toBe(true);
    }

    const recovered = await materializeWorkspaceTurnAttachFileArtifacts({
      ownerSessionDir,
      handleId: "wst_artifacts",
      parts,
    });
    expect(recovered).toEqual(descriptors);
    expect(
      await fsPromises.readdir(path.join(ownerSessionDir, "task-artifacts", "wst_artifacts"))
    ).toHaveLength(3);
  });

  test("caps the number of materialized artifacts per workspace turn", async () => {
    const ownerSessionDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "workspace-turn-artifact-cap-")
    );
    const parts = Array.from({ length: 12 }, (_, index) =>
      attachFilePart({
        toolCallId: `call-${index}`,
        data: Buffer.from(`file-${index}`).toString("base64"),
        mediaType: "application/pdf",
        filename: `file-${index}.pdf`,
      })
    );

    const descriptors = await materializeWorkspaceTurnAttachFileArtifacts({
      ownerSessionDir,
      handleId: "wst_capped",
      parts,
    });

    expect(descriptors).toHaveLength(10);
  });
});
