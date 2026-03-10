import * as crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  ALLOWED_AUDIO_EXTENSIONS,
  ALLOWED_AUDIO_MIME_TYPES,
  MAX_AUDIO_FILE_SIZE_BYTES,
} from "@/common/config/eventSoundTypes";
import { log } from "@/node/services/log";

type AllowedAudioExtension = (typeof ALLOWED_AUDIO_EXTENSIONS)[number];
type AllowedAudioMimeType = (typeof ALLOWED_AUDIO_MIME_TYPES)[number];

const EVENT_SOUND_ASSET_INDEX_VERSION = 1 as const;
const EVENT_SOUND_ASSET_ROUTE_PREFIX = "/assets/event-sounds";

const EXTENSION_TO_MIME: Record<AllowedAudioExtension, AllowedAudioMimeType> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  webm: "audio/webm",
};

const MIME_TO_EXTENSION: Record<AllowedAudioMimeType, AllowedAudioExtension> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "webm",
};

const EVENT_SOUND_ASSET_ID_PATTERN = /^[0-9a-f-]{36}\.[a-z0-9]+$/i;

export interface EventSoundAssetIndexEntry {
  assetId: string;
  fileName: string;
  originalName: string;
  mimeType: AllowedAudioMimeType;
  sizeBytes: number;
  createdAt: string;
}

interface EventSoundAssetIndexFile {
  version: typeof EVENT_SOUND_ASSET_INDEX_VERSION;
  assets: Record<string, EventSoundAssetIndexEntry>;
}

export interface UploadEventSoundAssetInput {
  base64: string;
  originalName: string;
  mimeType: string;
}

export interface EventSoundAsset {
  assetId: string;
  originalName: string;
  mimeType: string;
  playbackPath: string;
  createdAt: string;
}

export class EventSoundAssetService {
  private readonly assetsDirPath: string;
  private readonly indexFilePath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(muxHome: string) {
    this.assetsDirPath = path.join(muxHome, "assets", "event-sounds");
    this.indexFilePath = path.join(this.assetsDirPath, "index.json");
  }

  private async withSerializedMutation<T>(fn: () => Promise<T>): Promise<T> {
    let result!: T;
    const run = async () => {
      result = await fn();
    };

    const next = this.mutationQueue.catch(() => undefined).then(run);
    this.mutationQueue = next;
    await next;
    return result;
  }

  private async ensureStorageDir(): Promise<void> {
    await fsPromises.mkdir(this.assetsDirPath, { recursive: true });
  }

  private normalizeMimeType(mimeType: string): AllowedAudioMimeType | null {
    const normalized = mimeType.trim().toLowerCase();
    return (ALLOWED_AUDIO_MIME_TYPES as readonly string[]).includes(normalized)
      ? (normalized as AllowedAudioMimeType)
      : null;
  }

  private normalizeExtension(value: string): AllowedAudioExtension | null {
    const normalized = value.trim().toLowerCase().replace(/^\./, "");
    return (ALLOWED_AUDIO_EXTENSIONS as readonly string[]).includes(normalized)
      ? (normalized as AllowedAudioExtension)
      : null;
  }

  private getExtensionFromOriginalName(originalName: string): AllowedAudioExtension | null {
    return this.normalizeExtension(path.extname(originalName));
  }

  private validateSize(sizeBytes: number): void {
    if (sizeBytes > MAX_AUDIO_FILE_SIZE_BYTES) {
      throw new Error(
        `Audio file exceeds maximum allowed size of ${MAX_AUDIO_FILE_SIZE_BYTES} bytes`
      );
    }
  }

  private decodeBase64Payload(base64: string): Buffer {
    const normalized = base64.trim().replace(/\s+/g, "");
    if (!normalized || normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
      throw new Error("Invalid base64 payload");
    }

    const bytes = Buffer.from(normalized, "base64");
    if (bytes.length === 0) {
      throw new Error("Invalid base64 payload");
    }

    const normalizedNoPadding = normalized.replace(/=+$/, "");
    const reencodedNoPadding = bytes.toString("base64").replace(/=+$/, "");
    if (normalizedNoPadding !== reencodedNoPadding) {
      throw new Error("Invalid base64 payload");
    }

    return bytes;
  }

  private async readIndex(): Promise<Record<string, EventSoundAssetIndexEntry>> {
    try {
      const raw = await fsPromises.readFile(this.indexFilePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      if (!parsed || typeof parsed !== "object") {
        return {};
      }

      const index = parsed as { version?: unknown; assets?: unknown };
      if (index.version !== EVENT_SOUND_ASSET_INDEX_VERSION) {
        return {};
      }

      if (!index.assets || typeof index.assets !== "object") {
        return {};
      }

      const assets: Record<string, EventSoundAssetIndexEntry> = {};
      for (const [assetId, entry] of Object.entries(index.assets as Record<string, unknown>)) {
        if (!EVENT_SOUND_ASSET_ID_PATTERN.test(assetId)) {
          continue;
        }

        if (!entry || typeof entry !== "object") {
          continue;
        }

        const record = entry as Partial<EventSoundAssetIndexEntry>;
        if (
          typeof record.fileName !== "string" ||
          typeof record.originalName !== "string" ||
          typeof record.mimeType !== "string" ||
          typeof record.sizeBytes !== "number" ||
          typeof record.createdAt !== "string"
        ) {
          continue;
        }

        const normalizedMimeType = this.normalizeMimeType(record.mimeType);
        if (!normalizedMimeType) {
          continue;
        }

        assets[assetId] = {
          assetId,
          fileName: record.fileName,
          originalName: record.originalName,
          mimeType: normalizedMimeType,
          sizeBytes: record.sizeBytes,
          createdAt: record.createdAt,
        };
      }

      return assets;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return {};
      }

      log.warn("Failed to read event sound asset index; returning empty index", { error });
      return {};
    }
  }

  private async writeIndex(index: Record<string, EventSoundAssetIndexEntry>): Promise<void> {
    await this.ensureStorageDir();

    const payload: EventSoundAssetIndexFile = {
      version: EVENT_SOUND_ASSET_INDEX_VERSION,
      assets: index,
    };

    await writeFileAtomic(this.indexFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  }

  private async writeAssetFile(filePath: string, bytes: Buffer): Promise<void> {
    await this.ensureStorageDir();

    const tempPath = path.join(
      this.assetsDirPath,
      `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`
    );

    await fsPromises.writeFile(tempPath, bytes);

    try {
      await fsPromises.rename(tempPath, filePath);
    } catch (error) {
      await fsPromises.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private buildAssetId(
    extension: AllowedAudioExtension,
    index: Record<string, EventSoundAssetIndexEntry>
  ): string {
    for (;;) {
      const assetId = `${crypto.randomUUID()}.${extension}`;
      if (!(assetId in index)) {
        return assetId;
      }
    }
  }

  private toAsset(entry: EventSoundAssetIndexEntry): EventSoundAsset {
    return {
      assetId: entry.assetId,
      originalName: entry.originalName,
      mimeType: entry.mimeType,
      createdAt: entry.createdAt,
      playbackPath: this.getAssetPlaybackPath(entry.assetId),
    };
  }

  private assertAssetIdFormat(assetId: string): void {
    if (!EVENT_SOUND_ASSET_ID_PATTERN.test(assetId)) {
      throw new Error("Invalid asset id");
    }
  }

  private resolveIndexedAssetFilePath(fileName: string): string | null {
    if (!EVENT_SOUND_ASSET_ID_PATTERN.test(fileName)) {
      return null;
    }

    const filePath = path.resolve(this.assetsDirPath, fileName);
    const relative = path.relative(this.assetsDirPath, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    return filePath;
  }

  private async storeAsset(params: {
    bytes: Buffer;
    originalName: string;
    mimeType: AllowedAudioMimeType;
    extension: AllowedAudioExtension;
  }): Promise<EventSoundAsset> {
    const assets = await this.readIndex();
    const assetId = this.buildAssetId(params.extension, assets);
    const fileName = assetId;
    const filePath = path.join(this.assetsDirPath, fileName);

    await this.writeAssetFile(filePath, params.bytes);

    const entry: EventSoundAssetIndexEntry = {
      assetId,
      fileName,
      originalName: params.originalName,
      mimeType: params.mimeType,
      sizeBytes: params.bytes.byteLength,
      createdAt: new Date().toISOString(),
    };

    assets[assetId] = entry;

    try {
      await this.writeIndex(assets);
    } catch (error) {
      await fsPromises.rm(filePath, { force: true }).catch(() => undefined);
      throw error;
    }

    return this.toAsset(entry);
  }

  async importFromLocalPath(localPath: string): Promise<EventSoundAsset> {
    return this.withSerializedMutation(async () => {
      const extension = this.normalizeExtension(path.extname(localPath));
      if (!extension) {
        throw new Error("Unsupported audio file extension");
      }

      const stat = await fsPromises.stat(localPath);
      this.validateSize(stat.size);

      const bytes = await fsPromises.readFile(localPath);
      // Re-validate after reading in case the file grew between stat + read.
      this.validateSize(bytes.byteLength);

      return this.storeAsset({
        bytes,
        originalName: path.basename(localPath),
        mimeType: EXTENSION_TO_MIME[extension],
        extension,
      });
    });
  }

  async uploadFromData(input: UploadEventSoundAssetInput): Promise<EventSoundAsset> {
    return this.withSerializedMutation(async () => {
      const mimeType = this.normalizeMimeType(input.mimeType);
      if (!mimeType) {
        throw new Error("Unsupported audio MIME type");
      }

      const extensionFromName = this.getExtensionFromOriginalName(input.originalName);
      const extension = extensionFromName ?? MIME_TO_EXTENSION[mimeType];
      if (!extension) {
        throw new Error("Unsupported audio file extension");
      }

      const bytes = this.decodeBase64Payload(input.base64);
      this.validateSize(bytes.byteLength);

      const originalName = input.originalName.trim() || `event-sound.${extension}`;

      return this.storeAsset({
        bytes,
        originalName,
        mimeType,
        extension,
      });
    });
  }

  async deleteAsset(assetId: string): Promise<void> {
    await this.withSerializedMutation(async () => {
      this.assertAssetIdFormat(assetId);

      const assets = await this.readIndex();
      const entry = assets[assetId];
      if (!entry) {
        return;
      }

      const filePath = this.resolveIndexedAssetFilePath(entry.fileName);
      if (filePath) {
        await fsPromises.rm(filePath, { force: true });
      } else {
        log.warn("Skipping event sound asset file deletion for invalid indexed filename", {
          assetId,
          fileName: entry.fileName,
        });
      }

      delete assets[assetId];
      await this.writeIndex(assets);
    });
  }

  async listAssets(): Promise<EventSoundAsset[]> {
    const assets = await this.readIndex();

    return Object.values(assets)
      .sort((left, right) => {
        if (left.createdAt === right.createdAt) {
          return left.assetId.localeCompare(right.assetId);
        }

        return right.createdAt.localeCompare(left.createdAt);
      })
      .map((entry) => this.toAsset(entry));
  }

  async getAssetFilePath(assetId: string): Promise<string | null> {
    this.assertAssetIdFormat(assetId);

    const assets = await this.readIndex();
    const entry = assets[assetId];
    if (!entry) {
      return null;
    }

    const filePath = this.resolveIndexedAssetFilePath(entry.fileName);
    if (!filePath) {
      return null;
    }

    try {
      await fsPromises.access(filePath);
      return filePath;
    } catch {
      return null;
    }
  }

  getAssetPlaybackPath(assetId: string): string {
    this.assertAssetIdFormat(assetId);
    return `${EVENT_SOUND_ASSET_ROUTE_PREFIX}/${encodeURIComponent(assetId)}`;
  }
}
