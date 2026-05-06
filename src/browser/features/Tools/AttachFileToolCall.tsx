import React from "react";
import { Download, FileText } from "lucide-react";
import {
  ToolContainer,
  ToolHeader,
  ExpandIcon,
  ToolIcon,
  ToolName,
  StatusIndicator,
  ToolDetails,
  DetailSection,
  DetailLabel,
  DetailContent,
  LoadingDots,
} from "./Shared/ToolPrimitives";
import { useToolExpansion, getStatusDisplay, type ToolStatus } from "./Shared/toolUtils";
import { JsonHighlight } from "./Shared/HighlightedCode";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";

interface AttachFileToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

interface DisplayFilePart {
  type: "file-data";
  data: string;
  mediaType: string;
  filename?: string;
  providerOptions: {
    mux?: {
      displayOnly?: boolean;
      size?: number;
    };
  };
}

interface ContentResult {
  type: "content";
  value: unknown[];
}

function isContentResult(result: unknown): result is ContentResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { type?: unknown }).type === "content" &&
    Array.isArray((result as { value?: unknown }).value)
  );
}

function getMuxProviderOptions(value: unknown): { displayOnly?: boolean; size?: number } | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const muxOptions = (value as Record<string, unknown>).mux;
  if (typeof muxOptions !== "object" || muxOptions === null) {
    return null;
  }

  const record = muxOptions as Record<string, unknown>;
  return {
    ...(typeof record.displayOnly === "boolean" ? { displayOnly: record.displayOnly } : {}),
    ...(typeof record.size === "number" ? { size: record.size } : {}),
  };
}

function isDisplayFilePart(value: unknown): value is DisplayFilePart {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const muxOptions = getMuxProviderOptions(record.providerOptions);
  return (
    record.type === "file-data" &&
    typeof record.data === "string" &&
    typeof record.mediaType === "string" &&
    (record.filename === undefined || typeof record.filename === "string") &&
    muxOptions?.displayOnly === true
  );
}

function extractDisplayFilesFromToolResult(result: unknown): DisplayFilePart[] {
  if (!isContentResult(result)) {
    return [];
  }

  return result.value.filter(isDisplayFilePart);
}

function isValidBase64(data: string): boolean {
  if (data.length > 15_000_000) {
    return false;
  }
  return /^[A-Za-z0-9+/]*={0,2}$/.test(data);
}

function getBaseMediaType(mediaType: string): string {
  return mediaType.toLowerCase().trim().split(";")[0] ?? "application/octet-stream";
}

function createSafeDataUrl(file: DisplayFilePart): string | null {
  if (!isValidBase64(file.data)) {
    return null;
  }

  return `data:${getBaseMediaType(file.mediaType)};base64,${file.data}`;
}

function formatBytes(bytes: number | undefined): string | null {
  if (bytes == null) {
    return null;
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function filterResultForDisplay(result: unknown): unknown {
  if (!isContentResult(result)) {
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

    if (isDisplayFilePart(item)) {
      return {
        type: "file-data",
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

const DisplayOnlyFile: React.FC<{ file: DisplayFilePart }> = (props) => {
  const dataUrl = createSafeDataUrl(props.file);
  const baseMediaType = getBaseMediaType(props.file.mediaType);
  const label = props.file.filename ?? `Attachment (${baseMediaType})`;
  const formattedSize = formatBytes(getMuxProviderOptions(props.file.providerOptions)?.size);

  return (
    <div className="border-border-light bg-dark mt-2 max-w-xl rounded border p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-[var(--color-subtle)]">
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium text-[var(--color-text)]">{label}</span>
        <span className="counter-nums text-xs">{baseMediaType}</span>
        {formattedSize != null && <span className="counter-nums text-xs">{formattedSize}</span>}
      </div>

      {dataUrl != null && baseMediaType.startsWith("video/") && (
        <video controls src={dataUrl} className="max-h-80 max-w-full rounded" />
      )}
      {dataUrl != null && baseMediaType.startsWith("audio/") && (
        <audio controls src={dataUrl} className="w-full" />
      )}

      <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-subtle)]">
        <span>Shown to the user only; not sent to the model as a file attachment.</span>
        {dataUrl != null && (
          <a
            href={dataUrl}
            download={props.file.filename ?? "attachment"}
            className="border-border-light hover:bg-surface flex items-center gap-1 rounded border px-2 py-1 text-[var(--color-text)]"
          >
            <Download className="h-3 w-3" />
            Download
          </a>
        )}
      </div>
    </div>
  );
};

export const AttachFileToolCall: React.FC<AttachFileToolCallProps> = (props) => {
  const { expanded, toggleExpanded } = useToolExpansion();
  const displayFiles = extractDisplayFilesFromToolResult(props.result);
  const hasDisplayFiles = displayFiles.length > 0;
  const hasDetails = props.args !== undefined || props.result !== undefined;
  const images = extractImagesFromToolResult(props.result);
  const hasImages = images.length > 0;
  const shouldShowDetails = expanded || hasImages || hasDisplayFiles;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader onClick={() => hasDetails && toggleExpanded()}>
        {hasDetails && <ExpandIcon expanded={shouldShowDetails}>▶</ExpandIcon>}
        <ToolIcon toolName={props.toolName} />
        <ToolName>{props.toolName}</ToolName>
        <StatusIndicator status={props.status ?? "pending"}>
          {getStatusDisplay(props.status ?? "pending")}
        </StatusIndicator>
      </ToolHeader>

      {hasImages && <ToolResultImages result={props.result} />}
      {hasDisplayFiles && (
        <div className="space-y-2">
          {displayFiles.map((file, index) => (
            <DisplayOnlyFile key={`${file.filename ?? file.mediaType}-${index}`} file={file} />
          ))}
        </div>
      )}

      {expanded && hasDetails && (
        <ToolDetails>
          {props.args !== undefined && (
            <DetailSection>
              <DetailLabel>Arguments</DetailLabel>
              <DetailContent>
                <JsonHighlight value={props.args} />
              </DetailContent>
            </DetailSection>
          )}

          {props.result !== undefined && (
            <DetailSection>
              <DetailLabel>Result</DetailLabel>
              <DetailContent>
                <JsonHighlight value={filterResultForDisplay(props.result)} />
              </DetailContent>
            </DetailSection>
          )}

          {props.status === "executing" && props.result === undefined && (
            <DetailSection>
              <DetailContent>
                Waiting for result
                <LoadingDots />
              </DetailContent>
            </DetailSection>
          )}
          {props.status === "redacted" && (
            <DetailSection>
              <DetailContent className="text-muted italic">
                Output excluded from shared transcript
              </DetailContent>
            </DetailSection>
          )}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
