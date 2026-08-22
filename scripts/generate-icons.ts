#!/usr/bin/env bun
/**
 * Icon generation script for xum.
 *
 * Usage:
 *   bun scripts/generate-icons.ts [commands...]
 *
 * Commands:
 *   update           - Regenerate all logo sources and derived assets
 *   check            - Verify tracked assets without writing files
 *   png              - Generate build/icon.png (512x512)
 *   icns             - Generate build/icon.icns (macOS app icon)
 *   linux-icons      - Generate build/icons/{16x16..512x512}.png (Linux icon set)
 *
 * If no command is given, defaults to: png icns
 */
import { mkdir, rm, copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  renderAppWordmark,
  renderDocsWordmark,
  renderInlineAppWordmark,
  renderSquareLogo,
} from "./logoAssets";

const ICONSET_SIZES = [16, 32, 64, 128, 256, 512];
const FAVICON_SIZES = [16, 32, 48, 64, 128, 256];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Source logos
const SOURCE_BLACK = path.join(ROOT, "docs", "img", "logo-black.svg");
const SOURCE_WHITE = path.join(ROOT, "docs", "img", "logo-white.svg");

const WORDMARK_TARGETS = {
  "docs/img/black-xum.svg": renderDocsWordmark("black"),
  "docs/img/white-xum.svg": renderDocsWordmark("white"),
  "src/browser/assets/logos/xum-logo-dark.svg": renderAppWordmark("white"),
  "src/browser/assets/logos/xum-logo-light.svg": renderAppWordmark("black"),
} as const;

const INLINE_WORDMARK_TARGETS = {
  "index.html": "boot-loader__logo",
  "static/splash.html": "logo",
} as const;

// Build outputs
const BUILD_DIR = path.join(ROOT, "build");
const ICONSET_DIR = path.join(BUILD_DIR, "icon.iconset");
const PNG_OUTPUT = path.join(BUILD_DIR, "icon.png");
const ICNS_OUTPUT = path.join(BUILD_DIR, "icon.icns");
const LINUX_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512] as const;
const LINUX_ICON_DIR = path.join(BUILD_DIR, "icons");
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
  /** Square side length, or [width, height] for non-square (e.g. wide tray icons). */
  size: number | [number, number];
  source: string;
  bg: boolean;
  format?: "png" | "webp";
  /** Override the SVG viewBox before rendering to crop tightly around content. */
  cropViewBox?: string;
};

type SvgTargetConfig = {
  svg: true;
  source: string;
};

type LogoTargetConfig = RasterTargetConfig | SvgTargetConfig;

// Keep the source + background pairing centralized so targets stay DRY.
const MONO_ICON = { source: SOURCE_BLACK, bg: false } as const;
const APP_ICON = { source: SOURCE_WHITE, bg: true } as const;

// Crop to the centered ribbon-mark bounds so it fills small tray images while
// retaining enough breathing room to preserve the open center at 24px.
// Content bounds: x 10…62, y 6…58. The 60-unit crop yields 1.6px margins at 24px.
const TRAY_MARK_CROP = "6 2 60 60";

// Targets to update (path -> config)
const LOGO_TARGETS = {
  // VS Code extension (Black on Transparent)
  "vscode/icon.png": { size: 128, ...MONO_ICON },

  // Browser asset (Vector)
  "src/browser/assets/icons/xum.svg": { svg: true, source: SOURCE_BLACK },

  // Docs (docs.json points at logo-black/logo-white directly to avoid duplicates)
  "docs/img/logo.webp": { size: 512, ...MONO_ICON, format: "webp" },

  // PWA / Public Icons (White on Black Background for visibility)
  "public/icon.png": { size: 512, ...APP_ICON },
  "public/icon-192.png": { size: 192, ...APP_ICON },
  "public/icon-512.png": { size: 512, ...APP_ICON },

  // iOS Safari uses apple-touch-icon for home screen installs.
  "public/apple-touch-icon.png": { size: 180, ...APP_ICON },

  // Electron Tray Icons – Xum Mark (Monochrome on Transparent)
  //
  // Crop the source's outer padding so the open-center mark stays clear at 24px.
  // Pixel dimensions: 24×24 @1x → 48×48 @2x → 72×72 @3x.
  //
  // macOS treats the black variant as a template image (adapts to light/dark
  // menu bar automatically). Windows/Linux switch between black/white at
  // runtime based on the OS theme.
  "public/tray-icon-black.png": { size: 24, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-black@2x.png": { size: 48, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-black@3x.png": { size: 72, ...MONO_ICON, cropViewBox: TRAY_MARK_CROP },
  "public/tray-icon-white.png": {
    size: 24,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
  "public/tray-icon-white@2x.png": {
    size: 48,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
  "public/tray-icon-white@3x.png": {
    size: 72,
    source: SOURCE_WHITE,
    bg: false,
    cropViewBox: TRAY_MARK_CROP,
  },
} satisfies Record<string, LogoTargetConfig>;

const APP_ICON_PADDING_RATIO = 0.2;

async function generateRasterIcon({
  source,
  size,
  bg,
  format = "png",
  cropViewBox,
}: RasterTargetConfig) {
  const [w, h] = Array.isArray(size) ? size : [size, size];

  // If cropViewBox is set, read the SVG and override its viewBox so the
  // content fills the render canvas instead of being letter-boxed inside
  // the original (padded) viewBox.
  let input: string | Buffer = source;
  if (cropViewBox) {
    const svg = await readFile(source, "utf8");
    input = Buffer.from(svg.replace(/viewBox="[^"]*"/, `viewBox="${cropViewBox}"`));
  }

  let pipeline;

  if (!bg) {
    // Monochrome on transparent – fit the SVG content within the target
    // dimensions, preserving aspect ratio and centering with alpha padding.
    pipeline = sharp(input).resize(w, h, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  } else {
    // White on Black composite (app icons only – always square)
    const padding = Math.round(w * APP_ICON_PADDING_RATIO);
    const logoSize = w - padding * 2;

    pipeline = sharp({
      create: {
        width: w,
        height: h,
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

function renderThemeFaviconSvg(svg: string) {
  const withCurrentColor = svg.replace(/fill="(black|white)"/g, 'fill="currentColor"');
  return withCurrentColor.replace(/<svg[^>]*>/, (match) => `${match}\n${THEME_FAVICON_STYLE}`);
}

async function generateThemeFaviconSvg(output: string) {
  const svg = await readFile(SOURCE_BLACK, "utf8");
  await writeFile(output, renderThemeFaviconSvg(svg));
}

function replaceInlineWordmarkContent(html: string, relativePath: string, className: string) {
  const pattern = new RegExp(
    String.raw`^([ \t]*)<svg class="${className}"[\s\S]*?^[ \t]*</svg>`,
    "m"
  );
  const match = html.match(pattern);
  if (!match) {
    throw new Error(`Could not find ${className} logo in ${relativePath}`);
  }

  const indent = match[1];
  const svg = renderInlineAppWordmark(className)
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
  return html.replace(pattern, svg);
}

async function replaceInlineWordmark(relativePath: string, className: string) {
  const outputPath = path.join(ROOT, relativePath);
  const html = await readFile(outputPath, "utf8");
  await writeFile(outputPath, replaceInlineWordmarkContent(html, relativePath, className));
}

async function generateSourceLogos() {
  await writeFile(SOURCE_BLACK, renderSquareLogo("black"));
  console.log("✓ docs/img/logo-black.svg");
  await writeFile(SOURCE_WHITE, renderSquareLogo("white"));
  console.log("✓ docs/img/logo-white.svg");

  for (const [relativePath, svg] of Object.entries(WORDMARK_TARGETS)) {
    await writeFile(path.join(ROOT, relativePath), svg);
    console.log(`✓ ${relativePath}`);
  }

  for (const [relativePath, className] of Object.entries(INLINE_WORDMARK_TARGETS)) {
    await replaceInlineWordmark(relativePath, className);
    console.log(`✓ ${relativePath}`);
  }
}

async function updateAllLogos() {
  console.log(`Updating all logos...\n`);

  await generateSourceLogos();

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

function assertFresh(relativePath: string, actual: string | Buffer, expected: string | Buffer) {
  const matches =
    typeof actual === "string" && typeof expected === "string"
      ? actual === expected
      : Buffer.from(actual).equals(Buffer.from(expected));
  if (!matches) {
    throw new Error(`${relativePath} is stale; run bun scripts/generate-icons.ts update`);
  }
}

async function validateImage(
  relativePath: string,
  expectedDimensions: readonly (readonly [number, number])[]
) {
  const outputPath = path.join(ROOT, relativePath);
  const metadata = await sharp(outputPath, { page: 0 }).metadata();
  const dimensionsMatch = expectedDimensions.some(
    ([width, height]) => metadata.width === width && metadata.height === height
  );
  if (!dimensionsMatch) {
    throw new Error(
      `${relativePath} has unexpected dimensions ${metadata.width}x${metadata.height}`
    );
  }

  const stats = await sharp(outputPath, { page: 0 }).ensureAlpha().stats();
  const alpha = stats.channels[3];
  const hasPixelVariation = stats.channels.some((channel) => channel.min !== channel.max);
  if (!alpha || alpha.max === 0 || !hasPixelVariation) {
    throw new Error(`${relativePath} has no visible, non-uniform pixels`);
  }
}

async function checkGeneratedAssets() {
  console.log("Checking generated logo assets...\n");

  const squareBlack = renderSquareLogo("black");
  const squareWhite = renderSquareLogo("white");
  const textTargets = {
    "docs/img/logo-black.svg": squareBlack,
    "docs/img/logo-white.svg": squareWhite,
    ...WORDMARK_TARGETS,
    "src/browser/assets/icons/xum.svg": squareBlack,
    "docs/favicon.svg": renderThemeFaviconSvg(squareBlack),
  } as const;

  for (const [relativePath, expected] of Object.entries(textTargets)) {
    const actual = await readFile(path.join(ROOT, relativePath), "utf8");
    assertFresh(relativePath, actual, expected);
    await validateImage(relativePath, [
      [
        Math.round(Number(expected.match(/width="([\d.]+)"/)?.[1])),
        Math.round(Number(expected.match(/height="([\d.]+)"/)?.[1])),
      ],
    ]);
    console.log(`✓ ${relativePath}`);
  }

  for (const [relativePath, className] of Object.entries(INLINE_WORDMARK_TARGETS)) {
    const actual = await readFile(path.join(ROOT, relativePath), "utf8");
    const expected = replaceInlineWordmarkContent(actual, relativePath, className);
    assertFresh(relativePath, actual, expected);
    console.log(`✓ ${relativePath}`);
  }

  for (const [relativePath, config] of Object.entries(LOGO_TARGETS)) {
    if ("svg" in config) continue;

    const outputPath = path.join(ROOT, relativePath);
    const actual = await readFile(outputPath);
    const expected = await (await generateRasterIcon(config)).toBuffer();
    assertFresh(relativePath, actual, expected);
    const [width, height] = Array.isArray(config.size) ? config.size : [config.size, config.size];
    await validateImage(relativePath, [[width, height]]);
    console.log(`✓ ${relativePath}`);
  }

  const faviconDimensions = FAVICON_SIZES.map((size) => [size, size] as const);
  await validateImage("public/favicon.ico", faviconDimensions);
  console.log("✓ public/favicon.ico");
  await validateImage("public/favicon-dark.ico", faviconDimensions);
  console.log("✓ public/favicon-dark.ico");

  console.log("\n✅ All tracked logo assets are fresh and parseable!");
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

async function generateLinuxIcons() {
  await rm(LINUX_ICON_DIR, { recursive: true, force: true });
  await mkdir(LINUX_ICON_DIR, { recursive: true });

  await Promise.all(
    LINUX_ICON_SIZES.map(async (size) => {
      const img = await generateRasterIcon({ size, ...APP_ICON });
      await img.toFile(path.join(LINUX_ICON_DIR, `${size}x${size}.png`));
    })
  );
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

if (commands.has("check")) {
  await checkGeneratedAssets();
}

if (commands.has("linux-icons")) {
  await mkdir(BUILD_DIR, { recursive: true });
  await generateLinuxIcons();
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
    } finally {
      // Only the ICNS process owns this directory; parallel PNG builds must not remove it.
      await rm(ICONSET_DIR, { recursive: true, force: true });
    }
  }
}
