import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import {
  MAX_WORKSPACE_TURN_ATTACH_FILE_ARTIFACTS,
  WORKSPACE_TURN_TASK_ARTIFACTS_DIR,
} from "@/common/constants/taskArtifacts";
import type { CompletedMessagePart } from "@/common/types/stream";
import type { TaskAttachFileArtifact } from "@/common/types/taskArtifacts";
import { isDynamicToolPart } from "@/common/types/toolParts";
import {
  getDisplayOnlyFileMetadata,
  isDisplayOnlyFilePart,
} from "@/common/utils/attachments/displayOnlyFileParts";
import { isValidBase64AttachmentData } from "@/common/utils/attachments/base64";
import { AttachFileToolResultSchema } from "@/common/utils/tools/toolDefinitions";
import { MAX_ATTACH_FILE_SIZE_BYTES } from "@/node/utils/attachments/readAttachmentFromPath";
import { log } from "@/node/services/log";

interface MaterializeWorkspaceTurnAttachFileArtifactsArgs {
  ownerSessionDir: string;
  handleId: string;
  parts: readonly CompletedMessagePart[];
}

interface ExtractedAttachFileArtifact {
  data: string;
  mediaType: string;
  filename?: string;
  displayOnly?: true;
  expectedSize?: number;
  sourceToolCallId: string;
}

const UNSAFE_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');

function isControlCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  return code <= 31 || code === 127;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some(isControlCharacter);
}

function sanitizeFilename(filename: string | undefined, mediaType: string): string {
  const basename = filename == null ? "" : path.basename(filename.replaceAll("\\", "/"));
  const sanitized = Array.from(basename)
    .map((character) =>
      isControlCharacter(character) || UNSAFE_FILENAME_CHARACTERS.has(character) ? "_" : character
    )
    .join("")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 160);
  if (sanitized.length > 0) {
    return sanitized;
  }

  const extension =
    mediaType === "application/pdf"
      ? "pdf"
      : mediaType === "image/png"
        ? "png"
        : mediaType === "image/jpeg"
          ? "jpg"
          : mediaType === "image/gif"
            ? "gif"
            : mediaType === "image/webp"
              ? "webp"
              : mediaType === "image/svg+xml"
                ? "svg"
                : "bin";
  return `attachment.${extension}`;
}

function decodeAttachmentData(data: string): Buffer | null {
  if (data.length === 0 || data.length % 4 === 1 || !isValidBase64AttachmentData(data)) {
    return null;
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_ATTACH_FILE_SIZE_BYTES) {
    return null;
  }

  const canonicalInput = data.replace(/=+$/, "");
  if (bytes.toString("base64").replace(/=+$/, "") !== canonicalInput) {
    return null;
  }
  return bytes;
}

function extractAttachFileArtifacts(
  parts: readonly CompletedMessagePart[]
): ExtractedAttachFileArtifact[] {
  const artifacts: ExtractedAttachFileArtifact[] = [];
  const seenToolCallIds = new Set<string>();

  for (const part of parts) {
    if (artifacts.length >= MAX_WORKSPACE_TURN_ATTACH_FILE_ARTIFACTS) {
      break;
    }
    if (
      !isDynamicToolPart(part) ||
      part.toolName !== "attach_file" ||
      part.state !== "output-available" ||
      part.toolCallId.trim().length === 0 ||
      part.toolCallId.length > 512 ||
      seenToolCallIds.has(part.toolCallId)
    ) {
      continue;
    }

    const parsed = AttachFileToolResultSchema.safeParse(part.output);
    if (!parsed.success || "success" in parsed.data) {
      continue;
    }

    const filePart = parsed.data.value[1];
    const mediaType = filePart.mediaType.trim();
    if (mediaType.length === 0 || mediaType.length > 255 || containsControlCharacter(mediaType)) {
      continue;
    }

    const displayOnlyMetadata = isDisplayOnlyFilePart(filePart)
      ? getDisplayOnlyFileMetadata(filePart.providerOptions)
      : null;
    seenToolCallIds.add(part.toolCallId);
    artifacts.push({
      data: filePart.data,
      mediaType,
      ...(filePart.filename != null ? { filename: filePart.filename } : {}),
      ...(isDisplayOnlyFilePart(filePart)
        ? {
            displayOnly: true as const,
            ...(displayOnlyMetadata?.size != null
              ? { expectedSize: displayOnlyMetadata.size }
              : {}),
          }
        : {}),
      sourceToolCallId: part.toolCallId,
    });
  }

  return artifacts;
}

async function writeArtifactFile(filePath: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await fsPromises.readFile(filePath);
    if (existing.equals(bytes)) {
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fsPromises.writeFile(tempPath, bytes, { mode: 0o600 });
    await fsPromises.rename(tempPath, filePath);
  } finally {
    await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Copies child attach_file bytes into owner-session storage before disposable cleanup.
 * The child path is intentionally ignored: persisted tool output is the cross-runtime source of truth.
 */
export async function materializeWorkspaceTurnAttachFileArtifacts(
  args: MaterializeWorkspaceTurnAttachFileArtifactsArgs
): Promise<TaskAttachFileArtifact[]> {
  if (!/^wst_[a-z0-9][a-z0-9_-]*$/.test(args.handleId)) {
    log.warn("Ignoring workspace-turn attachment materialization for unsafe handle ID", {
      handleId: args.handleId,
    });
    return [];
  }

  const extracted = extractAttachFileArtifacts(args.parts);
  if (extracted.length === 0) {
    return [];
  }

  const handleDir = path.join(
    args.ownerSessionDir,
    WORKSPACE_TURN_TASK_ARTIFACTS_DIR,
    args.handleId
  );
  await fsPromises.mkdir(handleDir, { recursive: true, mode: 0o700 });

  const descriptors: TaskAttachFileArtifact[] = [];
  for (const artifact of extracted) {
    const bytes = decodeAttachmentData(artifact.data);
    if (
      bytes == null ||
      (artifact.expectedSize != null && artifact.expectedSize !== bytes.length)
    ) {
      continue;
    }

    const filename = sanitizeFilename(artifact.filename, artifact.mediaType);
    const storageKey = createHash("sha256")
      .update(artifact.sourceToolCallId)
      .digest("hex")
      .slice(0, 16);
    const artifactPath = path.join(handleDir, `${storageKey}-${filename}`);

    try {
      await writeArtifactFile(artifactPath, bytes);
      descriptors.push({
        path: artifactPath,
        ...(artifact.filename != null ? { filename } : {}),
        mediaType: artifact.mediaType,
        ...(artifact.displayOnly ? { displayOnly: true as const } : {}),
        sourceToolCallId: artifact.sourceToolCallId,
      });
    } catch (error) {
      log.warn("Ignoring workspace-turn attach_file artifact that could not be materialized", {
        handleId: args.handleId,
        toolCallId: artifact.sourceToolCallId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return descriptors;
}
