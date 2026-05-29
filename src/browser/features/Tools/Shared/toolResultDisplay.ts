import { isDisplayOnlyFilePart } from "@/common/utils/attachments/displayOnlyFileParts";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";

export function redactToolResultAttachmentsForDisplay(result: unknown): unknown {
  if (!isToolContentResult(result)) {
    return result;
  }

  const filteredValue = result.value.map((item) => {
    if (typeof item !== "object" || item === null) {
      return item;
    }

    const itemType = (item as { type?: unknown }).type;
    if (itemType === "media") {
      const mediaItem = item as { mediaType?: string; filename?: string };
      return {
        type: "media",
        mediaType: mediaItem.mediaType,
        filename: mediaItem.filename,
        data: "[attachment data]",
      };
    }

    if (isDisplayOnlyFilePart(item)) {
      return {
        type: "display_file",
        mediaType: item.mediaType,
        filename: item.filename,
        providerOptions: item.providerOptions,
        data: "[display-only file data]",
      };
    }

    return item;
  });

  return { ...result, value: filteredValue };
}
