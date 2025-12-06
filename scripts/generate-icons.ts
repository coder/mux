#!/usr/bin/env bun
/**
 * Icon generation script for mux.
 *
 * Usage:
 *   bun scripts/generate-icons.ts [commands...]
 *
 * Commands:
 *   update <source>  - Update all logo files from a source image (webp/png/jpg)
 *   png              - Generate build/icon.png (512x512)
 *   icns             - Generate build/icon.icns (macOS app icon)
 *
 * If no command is given, defaults to: png icns
 *
 * Examples:
 *   bun scripts/generate-icons.ts update ~/Pictures/new-logo.webp
 *   bun scripts/generate-icons.ts png icns
 */
import { mkdir, rm, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ICONSET_SIZES = [16, 32, 64, 128, 256, 512];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Source logo - all other icons are derived from this
const SOURCE = path.join(ROOT, "docs", "img", "logo.webp");

// Build outputs
const BUILD_DIR = path.join(ROOT, "build");
const ICONSET_DIR = path.join(BUILD_DIR, "icon.iconset");
const PNG_OUTPUT = path.join(BUILD_DIR, "icon.png");
const ICNS_OUTPUT = path.join(BUILD_DIR, "icon.icns");

// All logo locations that need updating (icon-only, not text logos)
const LOGO_TARGETS = {
  // VS Code extension
  "vscode/icon.png": { size: 128 },
  // Browser asset
  "src/browser/assets/icons/mux.svg": { size: 1024, svg: true },
} as const;

const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];

async function generatePngFromSource(source: string, output: string, size: number) {
  await sharp(source).resize(size, size).toFile(output);
}

async function generateSvgWithEmbeddedPng(source: string, output: string, size: number) {
  const pngBuffer = await sharp(source).resize(size, size).png().toBuffer();
  const base64 = pngBuffer.toString("base64");
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <image width="${size}" height="${size}" xlink:href="data:image/png;base64,${base64}"/>
</svg>
`;
  await writeFile(output, svg);
}

async function generateFavicon(source: string, output: string) {
  // Use ImageMagick if available for proper multi-resolution ICO
  try {
    const proc = Bun.spawn(
      [
        "magick",
        source,
        "-resize",
        "256x256",
        "-define",
        `icon:auto-resize=${FAVICON_SIZES.join(",")}`,
        output,
      ],
      { stdout: "ignore", stderr: "ignore" }
    );
    const status = await proc.exited;
    if (status === 0) return;
  } catch {
    // ImageMagick not available
  }

  // Fallback: just use the 256x256 PNG renamed as ICO (works in most browsers)
  const pngBuffer = await sharp(source).resize(256, 256).png().toBuffer();
  await writeFile(output, pngBuffer);
  console.warn("  ⚠ ImageMagick not found, favicon.ico is single-resolution");
}

async function updateAllLogos(sourcePath: string) {
  const resolvedSource = path.resolve(sourcePath);
  console.log(`Updating all logos from: ${resolvedSource}\n`);

  // First, copy source to canonical location
  const sourceExt = path.extname(resolvedSource).toLowerCase();
  if (sourceExt === ".webp") {
    await copyFile(resolvedSource, SOURCE);
    console.log(`✓ docs/img/logo.webp (source)`);
  } else {
    // Convert to webp
    await sharp(resolvedSource).webp().toFile(SOURCE);
    console.log(`✓ docs/img/logo.webp (converted from ${sourceExt})`);
  }

  // Generate all PNG targets
  for (const [relativePath, config] of Object.entries(LOGO_TARGETS)) {
    const outputPath = path.join(ROOT, relativePath);
    if (config.svg) {
      await generateSvgWithEmbeddedPng(SOURCE, outputPath, config.size);
    } else {
      await generatePngFromSource(SOURCE, outputPath, config.size);
    }
    console.log(`✓ ${relativePath} (${config.size}x${config.size})`);
  }

  // Generate favicon.ico
  const faviconPath = path.join(ROOT, "public", "favicon.ico");
  await generateFavicon(SOURCE, faviconPath);
  console.log(`✓ public/favicon.ico (multi-resolution)`);

  console.log("\n✅ All logos updated successfully!");
}

async function generateBuildPng() {
  await sharp(SOURCE).resize(512, 512).toFile(PNG_OUTPUT);
}

async function generateIconsetPngs() {
  await mkdir(ICONSET_DIR, { recursive: true });

  const tasks = ICONSET_SIZES.flatMap((size) => {
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

// Parse arguments
const args = process.argv.slice(2);
const commands = new Set<string>();
let updateSource: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "update") {
    updateSource = args[++i];
    if (!updateSource) {
      console.error("Error: 'update' command requires a source image path");
      process.exit(1);
    }
    commands.add("update");
  } else {
    commands.add(args[i]);
  }
}

// Default to png + icns if no commands
if (commands.size === 0) {
  commands.add("png");
  commands.add("icns");
}

// Execute commands
if (commands.has("update") && updateSource) {
  await updateAllLogos(updateSource);
} else {
  await mkdir(BUILD_DIR, { recursive: true });

  const needsPng = commands.has("png") || commands.has("icns");
  const needsIcns = commands.has("icns");

  if (needsPng) {
    await generateBuildPng();
  }

  if (needsIcns) {
    await generateIconsetPngs();
    await generateIcns();
  }

  await rm(ICONSET_DIR, { recursive: true, force: true });
}
