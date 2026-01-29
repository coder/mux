#!/usr/bin/env bun
/**
 * Icon generation script for mux.
 *
 * Usage:
 *   bun scripts/generate-icons.ts [commands...]
 *
 * Commands:
 *   update           - Regenerate all derived icons from docs/img/logo-*.svg
 *   png              - Generate build/icon.png (512x512)
 *   icns             - Generate build/icon.icns (macOS app icon)
 *
 * If no command is given, defaults to: png icns
 */
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ICONSET_SIZES = [16, 32, 64, 128, 256, 512];
const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Source logos
const SOURCE_BLACK = path.join(ROOT, "docs", "img", "logo-black.svg");
const SOURCE_WHITE = path.join(ROOT, "docs", "img", "logo-white.svg");

// Build outputs
const BUILD_DIR = path.join(ROOT, "build");
const ICONSET_DIR = path.join(BUILD_DIR, "icon.iconset");
const PNG_OUTPUT = path.join(BUILD_DIR, "icon.png");
const ICNS_OUTPUT = path.join(BUILD_DIR, "icon.icns");
const FAVICON_OUTPUT = path.join(ROOT, "public", "favicon.ico");
const FAVICON_DARK_OUTPUT = path.join(ROOT, "public", "favicon-dark.ico");

const THEME_FAVICON_STYLE = `<style>
  :root {
    color: #000;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      color: #fff;
    }
  }
</style>`;

type RasterTargetConfig = {
  size: number;
  source: string;
  bg: boolean;
  format?: "png" | "webp";
};

type SvgTargetConfig = {
  svg: true;
  source: string;
};

type LogoTargetConfig = RasterTargetConfig | SvgTargetConfig;

// Keep the source + background pairing centralized so targets stay DRY.
const MONO_ICON = { source: SOURCE_BLACK, bg: false } as const;
const APP_ICON = { source: SOURCE_WHITE, bg: true } as const;

// Targets to update (path -> config)
const LOGO_TARGETS = {
  // VS Code extension (Black on Transparent)
  "vscode/icon.png": { size: 128, ...MONO_ICON },

  // Browser asset (Vector)
  "src/browser/assets/icons/mux.svg": { svg: true, source: SOURCE_BLACK },

  // Docs (docs.json points at logo-black/logo-white directly to avoid duplicates)
  "docs/img/logo.webp": { size: 512, ...MONO_ICON, format: "webp" },

  // PWA / Public Icons (White on Black Background for visibility)
  "public/icon.png": { size: 512, ...APP_ICON },
  "public/icon-192.png": { size: 192, ...APP_ICON },
  "public/icon-512.png": { size: 512, ...APP_ICON },
} satisfies Record<string, LogoTargetConfig>;

const APP_ICON_PADDING_RATIO = 0.2;

async function generateRasterIcon({ source, size, bg, format = "png" }: RasterTargetConfig) {
  let pipeline;

  if (!bg) {
    pipeline = sharp(source).resize(size, size);
  } else {
    // White on Black composite
    const padding = Math.round(size * APP_ICON_PADDING_RATIO);
    const logoSize = size - padding * 2;

    pipeline = sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    }).composite([
      {
        input: await sharp(source).resize(logoSize, logoSize, { fit: "contain" }).toBuffer(),
        gravity: "center",
      },
    ]);
  }

  return format === "webp" ? pipeline.webp() : pipeline.png();
}

async function generateFavicon(source: string, output: string) {
  // Favicon uses Black on Transparent
  // Use ImageMagick if available for proper multi-resolution ICO
  try {
    const proc = Bun.spawn(
      [
        "magick",
        source,
        "-background",
        "none",
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

  // Fallback: just use the 256x256 PNG renamed as ICO
  const pngBuffer = await sharp(source).resize(256, 256).png().toBuffer();
  await writeFile(output, pngBuffer);
  console.warn("  ⚠ ImageMagick not found, favicon.ico is single-resolution");
}

async function generateThemeFaviconSvg(output: string) {
  const svg = await readFile(SOURCE_BLACK, "utf8");
  const withCurrentColor = svg.replace(/fill="(black|white)"/g, 'fill="currentColor"');
  const themedSvg = withCurrentColor.replace(
    /<svg[^>]*>/,
    (match) => `${match}\n${THEME_FAVICON_STYLE}`
  );
  await writeFile(output, themedSvg);
}

async function updateAllLogos() {
  console.log(`Updating all logos...\n`);

  for (const [relativePath, config] of Object.entries(LOGO_TARGETS)) {
    const outputPath = path.join(ROOT, relativePath);

    if ("svg" in config) {
      // For SVG target, just copy the source SVG (optimize/clean if needed, but direct copy is safe)
      await copyFile(config.source, outputPath);
    } else {
      const img = await generateRasterIcon(config);
      await img.toFile(outputPath);
    }
    console.log(`✓ ${relativePath}`);
  }

  const docsFaviconPath = path.join(ROOT, "docs", "favicon.svg");
  await generateThemeFaviconSvg(docsFaviconPath);
  console.log("✓ docs/favicon.svg");

  // Generate favicons (light/dark)
  await generateFavicon(MONO_ICON.source, FAVICON_OUTPUT);
  console.log(`✓ public/favicon.ico`);
  await generateFavicon(SOURCE_WHITE, FAVICON_DARK_OUTPUT);
  console.log(`✓ public/favicon-dark.ico`);

  console.log("\n✅ All logos updated successfully!");
}

async function generateBuildPng() {
  // Build PNG is App Icon (White on Black)
  const img = await generateRasterIcon({ size: 512, ...APP_ICON });
  await img.toFile(PNG_OUTPUT);
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

    return outputs.map(async ({ file, dimension }) => {
      const img = await generateRasterIcon({ size: dimension, ...APP_ICON });
      await img.toFile(file);
    });
  });

  await Promise.all(tasks);
}

async function generateIcns() {
  if (process.platform !== "darwin") {
    // Skip if not on mac
    console.warn("Skipping ICNS generation (requires macOS)");
    return;
  }

  const proc = Bun.spawn(["iconutil", "-c", "icns", ICONSET_DIR, "-o", ICNS_OUTPUT]);
  const status = await proc.exited;
  if (status !== 0) {
    throw new Error("iconutil failed to generate .icns file");
  }
}

// Parse arguments
const commands = new Set(process.argv.slice(2));

// Default to png + icns if no commands
if (commands.size === 0) {
  commands.add("png");
  commands.add("icns");
}

if (commands.has("update")) {
  await updateAllLogos();
}

// Build commands
if (commands.has("png") || commands.has("icns")) {
  await mkdir(BUILD_DIR, { recursive: true });

  if (commands.has("png")) {
    await generateBuildPng();
  }

  if (commands.has("icns")) {
    await generateIconsetPngs();
    try {
      await generateIcns();
    } catch (e) {
      console.warn("Failed to generate ICNS:", e);
    }
  }

  await rm(ICONSET_DIR, { recursive: true, force: true });
}
