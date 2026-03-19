import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { log } from "@/node/services/log";

const ATTACHMENT_STORE_FILE_NAME = "browser-session-attachments.json";

export interface BrowserSessionAttachmentRecord {
  workspaceId: string;
  sessionId: string;
  streamPort: number;
}

interface PersistedBrowserSessionAttachmentFile {
  version: 1;
  attachments: Record<string, BrowserSessionAttachmentRecord>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isValidAttachmentRecord(
  value: unknown,
  workspaceId: string
): value is BrowserSessionAttachmentRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.workspaceId === workspaceId &&
    value.sessionId === getMuxBrowserSessionId(workspaceId) &&
    typeof value.streamPort === "number" &&
    Number.isFinite(value.streamPort) &&
    value.streamPort > 0
  );
}

export class BrowserSessionAttachmentStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    assert(rootDir.trim().length > 0, "BrowserSessionAttachmentStore requires a rootDir");
    this.filePath = path.join(rootDir, ATTACHMENT_STORE_FILE_NAME);
  }

  getAttachment(workspaceId: string): BrowserSessionAttachmentRecord | null {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    return this.readAttachments()[workspaceId] ?? null;
  }

  writeAttachment(workspaceId: string, streamPort: number): void {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    assert(
      Number.isFinite(streamPort) && streamPort > 0,
      "BrowserSessionAttachmentStore requires streamPort to be a positive finite number"
    );

    const attachments = this.readAttachments();
    attachments[workspaceId] = {
      workspaceId,
      sessionId: getMuxBrowserSessionId(workspaceId),
      streamPort,
    };
    this.writeAttachments(attachments);
  }

  deleteAttachment(workspaceId: string): void {
    assert(workspaceId.trim().length > 0, "workspaceId must not be empty");
    const attachments = this.readAttachments();
    if (!(workspaceId in attachments)) {
      return;
    }

    delete attachments[workspaceId];
    this.writeAttachments(attachments);
  }

  private readAttachments(): Record<string, BrowserSessionAttachmentRecord> {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }

      log.warn("Failed to read browser session attachment store", {
        error,
        filePath: this.filePath,
      });
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      log.warn("Ignoring malformed browser session attachment store", {
        error,
        filePath: this.filePath,
      });
      return {};
    }

    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.attachments)) {
      log.warn("Ignoring unexpected browser session attachment store payload", {
        filePath: this.filePath,
      });
      return {};
    }

    const attachments: Record<string, BrowserSessionAttachmentRecord> = {};
    for (const [workspaceId, value] of Object.entries(parsed.attachments)) {
      if (!isValidAttachmentRecord(value, workspaceId)) {
        continue;
      }

      attachments[workspaceId] = value;
    }

    return attachments;
  }

  private writeAttachments(attachments: Record<string, BrowserSessionAttachmentRecord>): void {
    const payload: PersistedBrowserSessionAttachmentFile = {
      version: 1,
      attachments,
    };

    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tempFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    renameSync(tempFilePath, this.filePath);
  }
}
