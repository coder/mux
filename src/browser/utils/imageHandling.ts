import type { ImagePart } from "@/common/orpc/types";
import { MAX_SVG_TEXT_CHARS, SVG_MEDIA_TYPE } from "@/common/constants/imageAttachments";
import type { ImageAttachment } from "@/browser/components/ImageAttachments";

/**
 * Generates a unique ID for an image attachment
 */
export function generateImageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Detects MIME type from file extension as fallback
 */
function getMimeTypeFromExtension(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: SVG_MEDIA_TYPE,
  };
  return mimeTypes[ext ?? ""] ?? "image/png";
}

/**
 * Convert ImageAttachment[] → ImagePart[] for API calls.
 *
 * Kept in imageHandling to ensure creation + send flows stay aligned.
 */
export function imageAttachmentsToImageParts(
  attachments: ImageAttachment[],
  options?: { validate?: boolean }
): ImagePart[] {
  const validate = options?.validate ?? false;

  return attachments.map((img, index) => {
    if (validate) {
      // Validate before sending to help with debugging
      if (!img.url || typeof img.url !== "string") {
        console.error(
          `Image attachment [${index}] has invalid url:`,
          typeof img.url,
          (img as { url?: unknown }).url
        );
      }
      if (typeof img.url === "string" && !img.url.startsWith("data:")) {
        console.error(`Image attachment [${index}] url is not a data URL:`, img.url.slice(0, 100));
      }
      if (!img.mediaType || typeof img.mediaType !== "string") {
        console.error(
          `Image attachment [${index}] has invalid mediaType:`,
          typeof img.mediaType,
          (img as { mediaType?: unknown }).mediaType
        );
      }
    }

    return {
      url: img.url,
      mediaType: img.mediaType,
    };
  });
}

/**
 * Converts a File to an ImageAttachment (data URL).
 */
export async function fileToImageAttachment(file: File): Promise<ImageAttachment> {
  // Use file.type if available, otherwise infer from extension
  const mediaType = file.type !== "" ? file.type : getMimeTypeFromExtension(file.name);

  // For SVGs we inline as text in provider requests. Large SVGs can error during send,
  // so fail fast here with a clear message.
  if (mediaType.toLowerCase().trim().split(";")[0] === SVG_MEDIA_TYPE) {
    const svgText = await file.text();
    if (svgText.length > MAX_SVG_TEXT_CHARS) {
      throw new Error(
        `SVG attachments must be ${MAX_SVG_TEXT_CHARS.toLocaleString()} characters or less (this one is ${svgText.length.toLocaleString()}).`
      );
    }

    return {
      id: generateImageId(),
      url: `data:${SVG_MEDIA_TYPE},${encodeURIComponent(svgText)}`,
      mediaType,
    };
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const result = event.target?.result as string;
      if (result) {
        resolve(result);
      } else {
        reject(new Error("Failed to read file"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

  return {
    id: generateImageId(),
    url: dataUrl,
    mediaType,
  };
}

/**
 * Extracts image files from clipboard items
 */
export function extractImagesFromClipboard(items: DataTransferItemList): File[] {
  const imageFiles: File[] = [];

  for (const item of Array.from(items)) {
    if (item?.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
  }

  return imageFiles;
}

/**
 * Checks if a file is likely an image based on extension
 */
function hasImageExtension(filename: string): boolean {
  const ext = filename.toLowerCase().split(".").pop();
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext ?? "");
}

/**
 * Extracts image files from drag and drop DataTransfer
 * Accepts files with image MIME type OR image file extensions (for macOS drag-and-drop)
 */
export function extractImagesFromDrop(dataTransfer: DataTransfer): File[] {
  const imageFiles: File[] = [];

  for (const file of Array.from(dataTransfer.files)) {
    // Accept files with image MIME type, or files with image extensions (macOS drag-drop has empty type)
    if (file.type.startsWith("image/") || (file.type === "" && hasImageExtension(file.name))) {
      imageFiles.push(file);
    }
  }

  return imageFiles;
}

/**
 * Processes multiple image files and converts them to attachments
 */
export async function processImageFiles(files: File[]): Promise<ImageAttachment[]> {
  return await Promise.all(files.map(fileToImageAttachment));
}
