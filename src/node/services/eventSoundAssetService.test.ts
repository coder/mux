import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { MAX_AUDIO_FILE_SIZE_BYTES } from "@/common/config/eventSoundTypes";

import { EventSoundAssetService } from "./eventSoundAssetService";

const KNOWN_MISSING_ASSET_ID = "00000000-0000-0000-0000-000000000000.wav";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectRejects(promise: Promise<unknown>, message: string): Promise<void> {
  let caught: unknown;

  try {
    await promise;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

describe("EventSoundAssetService", () => {
  let tempMuxHome: string;
  let service: EventSoundAssetService;

  beforeEach(async () => {
    tempMuxHome = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mux-event-sound-assets-"));
    service = new EventSoundAssetService(tempMuxHome);
  });

  afterEach(async () => {
    await fsPromises.rm(tempMuxHome, { recursive: true, force: true });
  });

  it("imports an audio file from local path", async () => {
    const sourcePath = path.join(tempMuxHome, "source.wav");
    const sourceBytes = Buffer.from([0, 1, 2, 3, 4, 5]);
    await fsPromises.writeFile(sourcePath, sourceBytes);

    const imported = await service.importFromLocalPath(sourcePath);

    expect(imported.assetId).toMatch(/^[0-9a-f-]{36}\.wav$/i);
    expect(imported.originalName).toBe("source.wav");
    expect(imported.mimeType).toBe("audio/wav");
    expect(imported.playbackPath).toBe(`/assets/event-sounds/${imported.assetId}`);

    const storedPath = await service.getAssetFilePath(imported.assetId);
    expect(storedPath).not.toBeNull();

    const storedBytes = await fsPromises.readFile(storedPath!);
    expect(Buffer.compare(storedBytes, sourceBytes)).toBe(0);
  });

  it("rejects local imports larger than the max size", async () => {
    const sourcePath = path.join(tempMuxHome, "oversize.wav");
    await fsPromises.writeFile(sourcePath, Buffer.alloc(MAX_AUDIO_FILE_SIZE_BYTES + 1, 1));

    await expectRejects(
      service.importFromLocalPath(sourcePath),
      "Audio file exceeds maximum allowed size"
    );
  });

  it("rejects local imports with unsupported extensions", async () => {
    const sourcePath = path.join(tempMuxHome, "not-audio.txt");
    await fsPromises.writeFile(sourcePath, "not audio");

    await expectRejects(
      service.importFromLocalPath(sourcePath),
      "Unsupported audio file extension"
    );
  });

  it("uploads an audio asset from base64 data", async () => {
    const sourceBytes = Buffer.from("mux-event-sound");

    const uploaded = await service.uploadFromData({
      base64: sourceBytes.toString("base64"),
      originalName: "upload.mp3",
      mimeType: "audio/mpeg",
    });

    expect(uploaded.assetId).toMatch(/^[0-9a-f-]{36}\.mp3$/i);
    expect(uploaded.mimeType).toBe("audio/mpeg");

    const storedPath = await service.getAssetFilePath(uploaded.assetId);
    expect(storedPath).not.toBeNull();

    const storedBytes = await fsPromises.readFile(storedPath!);
    expect(Buffer.compare(storedBytes, sourceBytes)).toBe(0);
  });

  it("rejects uploaded payloads larger than the max size", async () => {
    const oversizedPayload = Buffer.alloc(MAX_AUDIO_FILE_SIZE_BYTES + 1, 2).toString("base64");

    await expectRejects(
      service.uploadFromData({
        base64: oversizedPayload,
        originalName: "oversize.wav",
        mimeType: "audio/wav",
      }),
      "Audio file exceeds maximum allowed size"
    );
  });

  it("deletes stored assets from disk and index", async () => {
    const uploaded = await service.uploadFromData({
      base64: Buffer.from("to-delete").toString("base64"),
      originalName: "delete.wav",
      mimeType: "audio/wav",
    });

    const filePath = await service.getAssetFilePath(uploaded.assetId);
    expect(filePath).not.toBeNull();

    await service.deleteAsset(uploaded.assetId);

    expect(await service.getAssetFilePath(uploaded.assetId)).toBeNull();
    expect(await service.listAssets()).toEqual([]);
  });

  it("removes tampered index entries without deleting files outside the asset directory", async () => {
    const tamperedAssetId = "11111111-1111-1111-1111-111111111111.wav";
    const outsidePath = path.join(tempMuxHome, "outside.txt");
    await fsPromises.writeFile(outsidePath, "must-survive");

    const assetsDirPath = path.join(tempMuxHome, "assets", "event-sounds");
    const indexPath = path.join(assetsDirPath, "index.json");
    await fsPromises.mkdir(assetsDirPath, { recursive: true });

    await fsPromises.writeFile(
      indexPath,
      JSON.stringify(
        {
          version: 1,
          assets: {
            [tamperedAssetId]: {
              assetId: tamperedAssetId,
              fileName: "../../outside.txt",
              originalName: "tampered.wav",
              mimeType: "audio/wav",
              sizeBytes: 1,
              createdAt: new Date().toISOString(),
            },
          },
        },
        null,
        2
      ),
      "utf-8"
    );

    await service.deleteAsset(tamperedAssetId);

    expect(await fsPromises.readFile(outsidePath, "utf-8")).toBe("must-survive");
    expect(await service.listAssets()).toEqual([]);
  });

  it("treats deleteAsset for unknown ids as a no-op", async () => {
    await service.deleteAsset(KNOWN_MISSING_ASSET_ID);
  });

  it("lists assets in newest-first order", async () => {
    const first = await service.uploadFromData({
      base64: Buffer.from("first").toString("base64"),
      originalName: "first.wav",
      mimeType: "audio/wav",
    });

    await sleep(2);

    const second = await service.uploadFromData({
      base64: Buffer.from("second").toString("base64"),
      originalName: "second.wav",
      mimeType: "audio/wav",
    });

    const listed = await service.listAssets();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.assetId).toBe(second.assetId);
    expect(listed[1]?.assetId).toBe(first.assetId);
  });

  it("returns file paths for known assets and null for unknown assets", async () => {
    const uploaded = await service.uploadFromData({
      base64: Buffer.from("path-check").toString("base64"),
      originalName: "path-check.wav",
      mimeType: "audio/wav",
    });

    expect(await service.getAssetFilePath(uploaded.assetId)).not.toBeNull();
    expect(await service.getAssetFilePath(KNOWN_MISSING_ASSET_ID)).toBeNull();
  });

  it("persists the asset index across service re-instantiation", async () => {
    const uploaded = await service.uploadFromData({
      base64: Buffer.from("persisted").toString("base64"),
      originalName: "persisted.wav",
      mimeType: "audio/wav",
    });

    const reloadedService = new EventSoundAssetService(tempMuxHome);
    const listed = await reloadedService.listAssets();

    expect(listed).toHaveLength(1);
    expect(listed[0]?.assetId).toBe(uploaded.assetId);
    expect(await reloadedService.getAssetFilePath(uploaded.assetId)).not.toBeNull();
  });
});
