#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";
import packageJson from "../package.json";
import { resolveMacPackagedAppNames } from "../src/common/compat/macPackagedApp";

const { productFilename: EXECUTABLE_NAME, appBundleName: APP_NAME } = resolveMacPackagedAppNames(
  packageJson.build
);
const RELEASE_DIR = path.join(process.cwd(), "release");
const APP_ASAR_UNPACKED_NODE_MODULES = [
  ["node_modules", "sharp"],
  ["node_modules", "@img"],
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function listDirectoryEntries(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function findAppBundles(rootDir: string): Promise<{ matches: string[]; seen: string[] }> {
  const matches: string[] = [];
  const seen: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    const entries = await listDirectoryEntries(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && entry.name.endsWith(".app")) {
        seen.push(entryPath);
        // Compare the stored readdir name, not a case-folded stat path.
        if (entry.name === APP_NAME) {
          matches.push(entryPath);
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(rootDir);
  return { matches, seen };
}

async function chooseDefaultAppBundle(): Promise<string> {
  const { matches: appBundles, seen } = await findAppBundles(RELEASE_DIR);
  assert(
    appBundles.length > 0,
    `No ${APP_NAME} found under ${RELEASE_DIR}. Run make dist-mac first. Stored .app names: ${
      seen.length > 0 ? seen.join(", ") : "(none)"
    }`
  );

  const preferredSuffixes =
    process.arch === "arm64"
      ? [
          path.join("release", "mac-arm64", APP_NAME),
          path.join("release", "mac", APP_NAME),
          path.join("release", "mac-universal", APP_NAME),
          path.join("release", "mac-x64", APP_NAME),
        ]
      : [
          path.join("release", "mac-x64", APP_NAME),
          path.join("release", "mac", APP_NAME),
          path.join("release", "mac-universal", APP_NAME),
          path.join("release", "mac-arm64", APP_NAME),
        ];
  for (const suffix of preferredSuffixes) {
    const match = appBundles.find((appBundle) => appBundle.endsWith(suffix));
    if (match != null) {
      return match;
    }
  }

  return appBundles.sort()[0]!;
}

async function findFileMatching(rootDir: string, pattern: RegExp): Promise<string | null> {
  async function walk(dirPath: string): Promise<string | null> {
    const entries = await listDirectoryEntries(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nestedMatch = await walk(entryPath);
        if (nestedMatch != null) {
          return nestedMatch;
        }
        continue;
      }
      if (pattern.test(entry.name)) {
        return entryPath;
      }
    }
    return null;
  }

  return await walk(rootDir);
}

async function verifyUnpackedSharpAssets(appBundlePath: string): Promise<void> {
  const unpackedRoot = path.join(appBundlePath, "Contents", "Resources", "app.asar.unpacked");
  for (const segments of APP_ASAR_UNPACKED_NODE_MODULES) {
    const requiredPath = path.join(unpackedRoot, ...segments);
    const stat = await fs.stat(requiredPath).catch(() => null);
    assert(stat?.isDirectory(), `Missing unpacked runtime directory: ${requiredPath}`);
  }

  const unpackedNodeModules = path.join(unpackedRoot, "node_modules");
  const sharpBinaryPath = await findFileMatching(unpackedNodeModules, /sharp.*\.node$/);
  assert(
    sharpBinaryPath != null,
    `Missing unpacked sharp native binary under ${unpackedNodeModules}`
  );

  const libvipsPath = await findFileMatching(unpackedNodeModules, /libvips-cpp\..*\.dylib$/);
  assert(libvipsPath != null, `Missing unpacked libvips dylib under ${unpackedNodeModules}`);

  console.log(`[attach-file-smoke] unpacked sharp binary: ${sharpBinaryPath}`);
  console.log(`[attach-file-smoke] unpacked libvips dylib: ${libvipsPath}`);
}

async function createFixtureImages(
  tempDir: string
): Promise<{ pngPath: string; jpegPath: string }> {
  const pngPath = path.join(tempDir, "oversized.png");
  const jpegPath = path.join(tempDir, "rotated.jpg");

  await sharp({
    create: {
      width: 9001,
      height: 10,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toFile(pngPath);

  await sharp({
    create: {
      width: 10,
      height: 9001,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(jpegPath);

  return { pngPath, jpegPath };
}

async function resolvePackagedMacExecutable(appBundlePath: string): Promise<string> {
  const macOsDir = path.join(appBundlePath, "Contents", "MacOS");
  const entries = await listDirectoryEntries(macOsDir);
  const names = entries.map((entry) => entry.name);
  const match = entries.find((entry) => entry.name === EXECUTABLE_NAME);
  assert(
    match != null,
    `Expected Contents/MacOS/${EXECUTABLE_NAME} in ${appBundlePath}, found: ${
      names.length > 0 ? names.join(", ") : "(empty)"
    }`
  );
  return path.join(macOsDir, match.name);
}

async function runPackagedSmokeApp(
  appBundlePath: string,
  fixturePaths: { pngPath: string; jpegPath: string }
): Promise<void> {
  const executablePath = await resolvePackagedMacExecutable(appBundlePath);
  const tempMuxRoot = path.join(path.dirname(fixturePaths.pngPath), "mux-root");
  const result = spawnSync(executablePath, [], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      CI: process.env.CI ?? "true",
      CMUX_ALLOW_MULTIPLE_INSTANCES: "1",
      MUX_ROOT: tempMuxRoot,
      MUX_ATTACH_FILE_SMOKE_TEST_PNG_PATH: fixturePaths.pngPath,
      MUX_ATTACH_FILE_SMOKE_TEST_JPEG_PATH: fixturePaths.jpegPath,
    },
  });

  if ((result.stdout?.trim().length ?? 0) > 0) {
    console.log(result.stdout.trim());
  }
  if ((result.stderr?.trim().length ?? 0) > 0) {
    console.error(result.stderr.trim());
  }

  if (result.error != null) {
    throw result.error;
  }
  if (result.signal != null) {
    throw new Error(`Packaged attach-file smoke test was terminated by signal ${result.signal}`);
  }
  assert(
    result.status === 0,
    `Packaged attach-file smoke test failed with exit code ${result.status}`
  );
}

async function main(): Promise<void> {
  assert(process.platform === "darwin", "checkMacAttachFileRuntime.ts only runs on macOS");

  const requestedAppBundle = process.argv[2];
  const appBundlePath = requestedAppBundle ?? (await chooseDefaultAppBundle());
  const appStat = await fs.stat(appBundlePath).catch(() => null);
  assert(appStat?.isDirectory(), `macOS app bundle not found: ${appBundlePath}`);

  console.log(`[attach-file-smoke] using app bundle ${appBundlePath}`);
  await verifyUnpackedSharpAssets(appBundlePath);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-attach-file-smoke-"));
  try {
    const fixturePaths = await createFixtureImages(tempDir);
    await runPackagedSmokeApp(appBundlePath, fixturePaths);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("[attach-file-smoke] failed:", error);
  process.exitCode = 1;
});
