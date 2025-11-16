import React from "react";

export interface ImageAttachment {
  id: string;
  url: string;
  mediaType: string;
}

interface ImageAttachmentsProps {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
}

export const ImageAttachments: React.FC<ImageAttachmentsProps> = ({ images, onRemove }) => {
  if (images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 py-2">
      {images.map((image) => (
        <div
          key={image.id}
          className="border-border-light bg-dark group grid h-20 w-20 overflow-hidden rounded border"
        >
          <img
            src={image.url}
            alt="Attached image"
            className="pointer-events-none col-start-1 row-start-1 h-full w-full object-cover"
          />
          <button
            onClick={() => onRemove(image.id)}
            title="Remove image"
            className="col-start-1 row-start-1 m-0.5 flex h-5 w-5 cursor-pointer items-center justify-center self-start justify-self-end rounded-full border-0 bg-black/70 p-0 text-sm leading-none text-white hover:bg-black/90"
            aria-label="Remove image"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
};
