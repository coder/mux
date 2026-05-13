import { type CSSProperties, useState } from "react";
import { AlertTriangle, FileImage, Image as ImageIcon, Maximize2 } from "lucide-react";

import { CopyButton } from "@/browser/components/CopyButton/CopyButton";
import { ImageLightbox } from "@/browser/components/ImageLightbox";
import { TooltipIfPresent } from "@/browser/components/Tooltip/Tooltip";
import type { DisplayedMessage } from "@/common/types/message";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import { cn } from "@/common/lib/utils";

interface GeneratedImageMessageProps {
  message: Extract<DisplayedMessage, { type: "generated-image" }>;
  className?: string;
}

type GeneratedImageArtifact = GeneratedImageMessageProps["message"]["images"][number];

function getThumbnailDataUrl(image: GeneratedImageArtifact): string | null {
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

function getThumbnailAspectStyle(image: GeneratedImageArtifact): CSSProperties | undefined {
  const thumbnail = image.thumbnail;
  if (!thumbnail) {
    return undefined;
  }
  return { aspectRatio: `${thumbnail.width} / ${thumbnail.height}` };
}

function getImageMetadata(image: GeneratedImageArtifact): string[] {
  const metadata = [image.mediaType];
  if (image.thumbnail) {
    metadata.push(`${image.thumbnail.width}×${image.thumbnail.height}`);
  }
  return metadata;
}

interface GeneratedImageCardProps {
  image: GeneratedImageArtifact;
  index: number;
  imageCount: number;
  onSelect: (src: string) => void;
}

function GeneratedImageCard(props: GeneratedImageCardProps) {
  const dataUrl = getThumbnailDataUrl(props.image);
  const metadata = getImageMetadata(props.image);

  return (
    <figure className="border-border-light bg-background overflow-hidden rounded-lg border shadow-sm">
      {dataUrl ? (
        <TooltipIfPresent tooltip="Open preview" side="top">
          <button
            type="button"
            onClick={() => props.onSelect(dataUrl)}
            aria-label={`Open generated image ${props.index + 1} preview`}
            className={cn(
              "group relative flex w-full cursor-pointer items-center justify-center overflow-hidden bg-code-bg p-2",
              props.imageCount === 1 ? "min-h-72" : "min-h-48"
            )}
            style={getThumbnailAspectStyle(props.image)}
          >
            <img
              src={dataUrl}
              alt={`Generated image ${props.index + 1}`}
              className="max-h-full max-w-full rounded-sm object-contain shadow-md"
            />
            <span className="border-border-light bg-background-secondary/95 text-foreground pointer-events-none absolute right-3 bottom-3 inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              <Maximize2 className="h-3 w-3" aria-hidden="true" />
              Preview
            </span>
          </button>
        </TooltipIfPresent>
      ) : (
        <div className="text-muted bg-code-bg flex min-h-48 flex-col items-center justify-center gap-2 p-4 text-xs">
          <FileImage className="h-8 w-8 opacity-70" aria-hidden="true" />
          <span>Preview unavailable</span>
        </div>
      )}

      <figcaption className="border-border-light space-y-2 border-t p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <FileImage className="text-muted h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div
              className="text-foreground truncate text-xs font-medium"
              title={props.image.filename}
            >
              {props.image.filename}
            </div>
            <div className="text-muted counter-nums flex flex-wrap gap-x-2 text-[11px]">
              {metadata.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>
          <CopyButton text={props.image.path} className="!p-1.5" />
        </div>

        <code
          className="text-muted bg-code-bg block truncate rounded px-2 py-1 text-[11px]"
          title={props.image.path}
        >
          {props.image.path}
        </code>

        {props.image.revisedPrompt && (
          <div className="border-border-light bg-background-secondary rounded border px-2 py-1.5">
            <div className="text-muted mb-0.5 text-[10px] font-medium tracking-wide uppercase">
              Revised prompt
            </div>
            <div className="text-foreground-secondary line-clamp-3 text-[11px] leading-relaxed">
              {props.image.revisedPrompt}
            </div>
          </div>
        )}
      </figcaption>
    </figure>
  );
}

export function GeneratedImageMessage(props: GeneratedImageMessageProps) {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const imageCount = props.message.images.length;
  const title =
    imageCount === 1 ? "Generated image preview" : `Generated ${imageCount} image previews`;

  return (
    <div className={props.className}>
      <div className="border-border-light bg-background-secondary overflow-hidden rounded-xl border shadow-sm">
        <div className="border-border-light bg-background flex flex-col gap-3 border-b p-3">
          <div className="flex items-start gap-3">
            <div className="border-border-light bg-background-secondary flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
              <ImageIcon className="text-foreground h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-foreground text-sm font-semibold">{title}</div>
                <span className="border-border-light text-muted counter-nums rounded-full border px-2 py-0.5 text-[11px]">
                  {imageCount} {imageCount === 1 ? "artifact" : "artifacts"}
                </span>
                <span className="border-border-light text-muted rounded-full border px-2 py-0.5 text-[11px]">
                  {props.message.model}
                </span>
              </div>
            </div>
          </div>

          <div className="border-border-light bg-background-secondary rounded-lg border px-3 py-2">
            <div className="text-muted mb-1 text-[10px] font-medium tracking-wide uppercase">
              Prompt
            </div>
            <div className="text-foreground-secondary line-clamp-4 text-xs leading-relaxed">
              {props.message.prompt}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "grid gap-3 p-3",
            imageCount === 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2 xl:grid-cols-3"
          )}
        >
          {props.message.images.map((image, index) => (
            <GeneratedImageCard
              key={`${image.path}-${index}`}
              image={image}
              index={index}
              imageCount={imageCount}
              onSelect={setSelectedImage}
            />
          ))}
        </div>

        {props.message.warnings && props.message.warnings.length > 0 && (
          <div className="border-warning bg-warning-overlay text-warning mx-3 mb-3 flex gap-2 rounded-lg border px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <div>{props.message.warnings.join(" ")}</div>
          </div>
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
