import { tool } from "ai";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { AttachFileToolResult } from "@/common/types/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import { readAttachmentFromPath } from "@/node/utils/attachments/readAttachmentFromPath";

export const createAttachFileTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.attach_file.description,
    inputSchema: TOOL_DEFINITIONS.attach_file.schema,
    execute: async (
      { path, mediaType, filename },
      { abortSignal }
    ): Promise<AttachFileToolResult> => {
      assert(typeof path === "string" && path.trim().length > 0, "attach_file requires a path");

      try {
        const attachment = await readAttachmentFromPath({
          path,
          mediaType,
          filename,
          cwd: config.cwd,
          runtime: config.runtime,
          abortSignal,
        });
        assert(attachment.data.length > 0, "attach_file produced empty attachment data");

        return {
          type: "content",
          value: [
            {
              type: "text",
              text: `[Attachment prepared: ${attachment.filename ?? attachment.mediaType}]`,
            },
            {
              type: "media",
              data: attachment.data,
              mediaType: attachment.mediaType,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            },
          ],
        };
      } catch (error) {
        return {
          success: false,
          error: getErrorMessage(error),
        };
      }
    },
  });
};
