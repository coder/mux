import type React from "react";
import { Download, FileText } from "lucide-react";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import {
  MARKDOWN_MEDIA_TYPE,
  normalizeAttachmentMediaType,
} from "@/common/utils/attachments/supportedAttachmentMediaTypes";
import { formatBytes } from "@/common/utils/formatBytes";
import { isToolContentResult } from "@/common/utils/tools/toolContentResult";
import {
  getDisplayOnlyFileMetadata,
  isDisplayOnlyFilePart,
  type DisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import { MarkdownRenderer } from "../Messages/MarkdownRenderer";
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
import { redactToolResultAttachmentsForDisplay } from "./Shared/toolResultDisplay";
import { ToolResultImages, extractImagesFromToolResult } from "./Shared/ToolResultImages";

const MARKDOWN_PREVIEW_CHAR_LIMIT = 50_000;
const MARKDOWN_PREVIEW_MEDIA_TYPES = new Set([MARKDOWN_MEDIA_TYPE, "text/x-markdown"]);

interface AttachFileToolCallProps {
  toolName: string;
  args?: unknown;
  result?: unknown;
  status?: ToolStatus;
}

function extractDisplayFilesFromToolResult(result: unknown): DisplayOnlyFilePart[] {
  if (!isToolContentResult(result)) {
    return [];
  }

  return result.value.filter(isDisplayOnlyFilePart);
}

function createSafeDataUrl(file: DisplayOnlyFilePart): string | null {
  if (!isValidBase64AttachmentData(file.data)) {
    return null;
  }

  return `data:${normalizeAttachmentMediaType(file.mediaType)};base64,${file.data}`;
}

function isMarkdownPreviewMediaType(mediaType: string): boolean {
  return MARKDOWN_PREVIEW_MEDIA_TYPES.has(normalizeAttachmentMediaType(mediaType));
}

function decodeBase64Utf8(data: string): string | null {
  if (!isValidBase64AttachmentData(data)) {
    return null;
  }

  try {
    const binary = globalThis.atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function createMarkdownPreview(markdown: string): { content: string; truncated: boolean } {
  if (markdown.length <= MARKDOWN_PREVIEW_CHAR_LIMIT) {
    return { content: markdown, truncated: false };
  }

  return {
    content: markdown.slice(0, MARKDOWN_PREVIEW_CHAR_LIMIT),
    truncated: true,
  };
}

const DisplayOnlyFile: React.FC<{ file: DisplayOnlyFilePart }> = (props) => {
  const dataUrl = createSafeDataUrl(props.file);
  const baseMediaType = normalizeAttachmentMediaType(props.file.mediaType);
  const label = props.file.filename ?? `Attachment (${baseMediaType})`;
  const metadata = getDisplayOnlyFileMetadata(props.file.providerOptions);
  const formattedSize = metadata?.size != null ? formatBytes(metadata.size) : null;
  const markdownText = isMarkdownPreviewMediaType(baseMediaType)
    ? decodeBase64Utf8(props.file.data)
    : null;
  const markdownPreview = markdownText != null ? createMarkdownPreview(markdownText) : null;

  return (
    <div className="border-border-light bg-dark mt-2 max-w-xl rounded border p-3">
      <div className="mb-2 flex items-center gap-2 text-sm text-[var(--color-subtle)]">
        <FileText className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium text-[var(--color-text)]">{label}</span>
        <span className="counter-nums text-xs">{baseMediaType}</span>
        {formattedSize != null && <span className="counter-nums text-xs">{formattedSize}</span>}
      </div>

      {dataUrl != null && baseMediaType.startsWith("video/") && (
        <video controls src={dataUrl} title={label} className="max-h-80 max-w-full rounded" />
      )}
      {dataUrl != null && baseMediaType.startsWith("audio/") && (
        <audio controls src={dataUrl} title={label} className="w-full" />
      )}

      {markdownPreview != null && (
        <div className="border-border-light bg-background max-h-80 overflow-auto rounded border p-3 text-[11px]">
          <MarkdownRenderer content={markdownPreview.content} />
          {markdownPreview.truncated && (
            <div className="text-muted mt-3 border-t border-white/10 pt-2 text-xs">
              Preview truncated. Download the file to view the full markdown.
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex items-center gap-2 text-xs text-[var(--color-subtle)]">
        <span>Shown to the user only; not sent to the model as a file attachment.</span>
        {dataUrl == null && <span>File data is unavailable for preview or download.</span>}
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
        {hasDetails && <ExpandIcon expanded={expanded}>▶</ExpandIcon>}
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
                <JsonHighlight value={redactToolResultAttachmentsForDisplay(props.result)} />
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
