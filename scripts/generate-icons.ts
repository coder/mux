#!/usr/bin/env bun
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SIZES = [16, 32, 64, 128, 256, 512];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "docs", "img", "logo.webp");
const BUILD_DIR = path.join(ROOT, "build");
const ICONSET_DIR = path.join(BUILD_DIR, "icon.iconset");
const PNG_OUTPUT = path.join(BUILD_DIR, "icon.png");
const ICNS_OUTPUT = path.join(BUILD_DIR, "icon.icns");

const args = new Set(process.argv.slice(2));
if (args.size === 0) {
  args.add("png");
  args.add("icns");
}
const needsPng = args.has("png") || args.has("icns");
const needsIcns = args.has("icns");

async function generateIconPng() {
  await sharp(SOURCE).resize(512, 512).toFile(PNG_OUTPUT);
}

async function generateIconsetPngs() {
  await mkdir(ICONSET_DIR, { recursive: true });

  const tasks = SIZES.flatMap((size) => {
    const outputs = [
      {
        file: path.join(ICONSET_DIR, `icon_${size}x${size}.png`),
        dimension: size,
      },
    ];

    if (size <= 256) {
      const retina = size * 2;
      outputs.push({
        file: path.join(ICONSET_DIR, `icon_${size}x${size}@2x.png`),
        dimension: retina,
      });
    }

    return outputs.map(({ file, dimension }) =>
      sharp(SOURCE).resize(dimension, dimension, { fit: "cover" }).toFile(file)
    );
  });

  await Promise.all(tasks);
}

async function generateIcns() {
  if (process.platform !== "darwin") {
    throw new Error("ICNS generation requires macOS (iconutil)");
  }

  const proc = Bun.spawn(["iconutil", "-c", "icns", ICONSET_DIR, "-o", ICNS_OUTPUT]);
  const status = await proc.exited;
  if (status !== 0) {
    throw new Error("iconutil failed to generate .icns file");
  }
}

await mkdir(BUILD_DIR, { recursive: true });

if (needsPng) {
  await generateIconPng();
}

if (needsIcns) {
  await generateIconsetPngs();
  await generateIcns();
}

await rm(ICONSET_DIR, { recursive: true, force: true });
