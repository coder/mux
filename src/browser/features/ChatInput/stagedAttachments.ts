import type { ChatAttachment, StagedChatAttachment } from "./ChatAttachments";

const ATTACHED_FILES_OPEN_TAG = "<attached-files>";
const ATTACHED_FILES_CLOSE_TAG = "</attached-files>";
const ATTACHED_FILES_BLOCK_PATTERN = /\n?<attached-files>[\s\S]*?<\/attached-files>/gu;
const ATTACHED_FILE_LINE_PATTERN =
  /^- `(?<filename>[^`]+)` \(`(?<mediaType>[^`]+)`, (?<sizeLabel>[^)]+)\): `(?<stagedPath>[^`]+)`$/u;

export interface DisplayStagedAttachment {
  filename: string;
  mediaType: string;
  sizeLabel: string;
  stagedPath: string;
}

export function getStagedAttachments(attachments: ChatAttachment[]): StagedChatAttachment[] {
  return attachments.filter((attachment) => attachment.kind === "staged");
}

export function appendStagedAttachmentNotice(text: string, attachments: ChatAttachment[]): string {
  const notice = buildStagedAttachmentNotice(getStagedAttachments(attachments));
  if (notice.length === 0) {
    return text;
  }
  return text.trim().length > 0 ? `${text}\n${notice}` : notice.trimStart();
}

export function parseStagedAttachmentNotice(text: string): {
  text: string;
  attachments: DisplayStagedAttachment[];
} {
  const attachments: DisplayStagedAttachment[] = [];
  const visibleText = text.replace(ATTACHED_FILES_BLOCK_PATTERN, (block) => {
    attachments.push(...parseStagedAttachmentBlock(block));
    return "";
  });

  return { text: visibleText.trimEnd(), attachments };
}

export function stripStagedAttachmentNotice(text: string): string {
  return parseStagedAttachmentNotice(text).text;
}

export function buildStagedAttachmentNotice(attachments: StagedChatAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const lines = attachments.map(
    (attachment) =>
      `- \`${attachment.filename}\` (\`${attachment.mediaType}\`, ${formatBytes(attachment.sizeBytes)}): \`${attachment.stagedPath}\``
  );

  return `\n${ATTACHED_FILES_OPEN_TAG}\nThe user attached file(s) that were saved into the workspace filesystem. These are not native model attachments; use filesystem tools such as \`bash\`, \`file_read\`, or archive tools to inspect them if needed.\n\n${lines.join("\n")}\n${ATTACHED_FILES_CLOSE_TAG}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseStagedAttachmentBlock(block: string): DisplayStagedAttachment[] {
  const parsed: DisplayStagedAttachment[] = [];
  for (const line of block.split(/\r?\n/u)) {
    const match = ATTACHED_FILE_LINE_PATTERN.exec(line.trim());
    if (!match?.groups) {
      continue;
    }
    parsed.push({
      filename: match.groups.filename,
      mediaType: match.groups.mediaType,
      sizeLabel: match.groups.sizeLabel,
      stagedPath: match.groups.stagedPath,
    });
  }
  return parsed;
}
