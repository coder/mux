import { useState } from "react";
import { Image as ImageIcon } from "lucide-react";

import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { ImageLightbox } from "@/browser/components/ImageLightbox";
import type { DisplayedMessage } from "@/common/types/message";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";

interface GeneratedImageMessageProps {
  message: Extract<DisplayedMessage, { type: "generated-image" }>;
  className?: string;
}

function getThumbnailDataUrl(
  image: GeneratedImageMessageProps["message"]["images"][number]
): string | null {
  const thumbnail = image.thumbnail;
  if (!thumbnail) {
    return null;
  }
  const mediaType = thumbnail.mediaType.toLowerCase().trim();
  if (mediaType !== "image/webp" && mediaType !== "image/png" && mediaType !== "image/jpeg") {
    return null;
  }
  if (!isValidBase64AttachmentData(thumbnail.data)) {
    return null;
  }
  return `data:${mediaType};base64,${thumbnail.data}`;
}

export function GeneratedImageMessage(props: GeneratedImageMessageProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const imageCount = props.message.images.length;

  return (
    <div className={props.className}>
      <div className="border-border-light bg-background-secondary rounded-lg border p-3">
        <div className="mb-2 flex items-center gap-2">
          <ImageIcon className="text-muted h-4 w-4" aria-hidden="true" />
          <div className="text-foreground text-sm font-medium">
            Generated image {imageCount === 1 ? "preview" : "previews"}
          </div>
          <div className="text-muted text-xs">{props.message.model}</div>
        </div>

        <div className="text-muted mb-3 line-clamp-3 text-xs">{props.message.prompt}</div>

        <div
          className={
            imageCount === 1 ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"
          }
        >
          {props.message.images.map((image, index) => {
            const dataUrl = getThumbnailDataUrl(image);
            return (
              <div
                key={`${image.path}-${index}`}
                className="border-border-light bg-background/60 overflow-hidden rounded border"
              >
                {dataUrl ? (
                  <button
                    type="button"
                    onClick={() => setSelectedImage(dataUrl)}
                    className="bg-background flex h-64 w-full cursor-pointer items-center justify-center p-2 transition-opacity hover:opacity-80"
                  >
                    <img
                      src={dataUrl}
                      alt={`Generated image ${index + 1}`}
                      className="max-h-full max-w-full object-contain"
                    />
                  </button>
                ) : (
                  <div className="text-muted bg-background flex h-32 items-center justify-center text-xs">
                    Preview unavailable
                  </div>
                )}
                <div className="border-border-light flex items-start gap-2 border-t px-2 py-1.5">
                  <code className="text-muted min-w-0 flex-1 truncate text-xs" title={image.path}>
                    {image.path}
                  </code>
                  <CopyButton text={image.path} />
                </div>
                {image.revisedPrompt && (
                  <div className="text-muted line-clamp-2 px-2 pb-2 text-[11px]">
                    {image.revisedPrompt}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {props.message.warnings && props.message.warnings.length > 0 && (
          <div className="text-warning mt-3 text-xs">{props.message.warnings.join(" ")}</div>
        )}
      </div>

      <ImageLightbox
        src={selectedImage}
        title="Generated image preview"
        alt="Generated image preview"
        onClose={() => setSelectedImage(null)}
      />
    </div>
  );
}
