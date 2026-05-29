export interface DisplayOnlyFilePart {
  type: "display_file";
  data: string;
  mediaType: string;
  filename?: string;
  providerOptions?: {
    mux?: {
      displayOnly: true;
      size: number;
    };
  };
}

export interface DisplayOnlyFileMetadata {
  displayOnly: true;
  size: number;
}

export function createDisplayOnlyFilePart(args: {
  data: string;
  mediaType: string;
  filename?: string;
  size: number;
}): DisplayOnlyFilePart {
  return {
    type: "display_file",
    data: args.data,
    mediaType: args.mediaType,
    providerOptions: { mux: { displayOnly: true, size: args.size } },
    ...(args.filename ? { filename: args.filename } : {}),
  };
}

export function getDisplayOnlyFileMetadata(value: unknown): DisplayOnlyFileMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const muxOptions = (value as Record<string, unknown>).mux;
  if (typeof muxOptions !== "object" || muxOptions === null) {
    return null;
  }

  const record = muxOptions as Record<string, unknown>;
  if (record.displayOnly !== true || typeof record.size !== "number") {
    return null;
  }

  return {
    displayOnly: true,
    size: record.size,
  };
}

export function isDisplayOnlyFilePart(value: unknown): value is DisplayOnlyFilePart {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.type === "display_file" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string" &&
    (record.filename == null || typeof record.filename === "string")
  );
}
