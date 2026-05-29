import * as path from "node:path";
import sharp from "sharp";
import { MAX_IMAGE_DIMENSION } from "@/common/constants/imageAttachments";
import assert from "@/common/utils/assert";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { readAttachmentFromPath } from "@/node/utils/attachments/readAttachmentFromPath";

const ATTACH_FILE_SMOKE_TEST_PATH_ENV = {
  png: "MUX_ATTACH_FILE_SMOKE_TEST_PNG_PATH",
  jpeg: "MUX_ATTACH_FILE_SMOKE_TEST_JPEG_PATH",
} as const;

interface AttachFileSmokeInput {
  label: keyof typeof ATTACH_FILE_SMOKE_TEST_PATH_ENV;
  path: string;
  expectedMediaType: "image/png" | "image/jpeg";
  expectedWidth: number;
  expectedHeight: number;
  expectOrientationReset: boolean;
}

function readRequiredEnvPath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (value == null || value.length === 0) {
    return null;
  }
  assert(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

function getAttachFileSmokeInputs(): AttachFileSmokeInput[] {
  const pngPath = readRequiredEnvPath(ATTACH_FILE_SMOKE_TEST_PATH_ENV.png);
  const jpegPath = readRequiredEnvPath(ATTACH_FILE_SMOKE_TEST_PATH_ENV.jpeg);
  const inputs: AttachFileSmokeInput[] = [];

  if (pngPath != null) {
    inputs.push({
      label: "png",
      path: pngPath,
      expectedMediaType: "image/png",
      expectedWidth: MAX_IMAGE_DIMENSION,
      expectedHeight: 2,
      expectOrientationReset: false,
    });
  }

  if (jpegPath != null) {
    inputs.push({
      label: "jpeg",
      path: jpegPath,
      expectedMediaType: "image/jpeg",
      expectedWidth: MAX_IMAGE_DIMENSION,
      expectedHeight: 2,
      expectOrientationReset: true,
    });
  }

  return inputs;
}

export async function runAttachFileSmokeTest(): Promise<void> {
  // Keep the packaged-app smoke test close to the real attach_file implementation so
  // CI catches ASAR regressions before nightly assets ship.
  const inputs = getAttachFileSmokeInputs();
  assert(inputs.length > 0, "Attach-file smoke test requires at least one image path");

  const runtime = new LocalRuntime(path.dirname(inputs[0].path));
  const results: Array<{
    label: AttachFileSmokeInput["label"];
    mediaType: string;
    width: number;
    height: number;
    orientation: number | undefined;
    resizedBytes: number;
  }> = [];

  for (const input of inputs) {
    const attachment = await readAttachmentFromPath({
      path: input.path,
      cwd: path.dirname(input.path),
      runtime,
    });
    assert(
      attachment.mediaType === input.expectedMediaType,
      `Expected ${input.label} smoke attachment media type ${input.expectedMediaType}, got ${attachment.mediaType}`
    );

    const metadata = await sharp(Buffer.from(attachment.data, "base64")).metadata();
    assert(
      metadata.width === input.expectedWidth,
      `Expected ${input.label} smoke attachment width ${input.expectedWidth}, got ${metadata.width ?? "<missing>"}`
    );
    assert(
      metadata.height === input.expectedHeight,
      `Expected ${input.label} smoke attachment height ${input.expectedHeight}, got ${metadata.height ?? "<missing>"}`
    );

    if (input.expectOrientationReset) {
      assert(
        metadata.orientation == null || metadata.orientation === 1,
        `Expected ${input.label} smoke attachment orientation to be reset, got ${metadata.orientation ?? "<missing>"}`
      );
    }

    results.push({
      label: input.label,
      mediaType: attachment.mediaType,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      orientation: metadata.orientation,
      resizedBytes: Buffer.from(attachment.data, "base64").length,
    });
  }

  console.log(`[attach-file-smoke] ${JSON.stringify(results)}`);
}
