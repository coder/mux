#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { Dirent } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

const APP_NAME = "mux.app";
const RELEASE_DIR = path.join(process.cwd(), "release");
const APP_ASAR_UNPACKED_NODE_MODULES = [
  ["node_modules", "sharp"],
  ["node_modules", "@img"],
] as const;

type MacAppArchitecture = "x64" | "arm64";

interface SharpRuntimePackages {
  binding: string;
  libvips: string;
}

const MAC_APP_ARCHITECTURES: MacAppArchitecture[] = ["x64", "arm64"];
const SHARP_RUNTIME_PACKAGES_BY_ARCHITECTURE: Record<MacAppArchitecture, SharpRuntimePackages> = {
  x64: {
    binding: "sharp-darwin-x64",
    libvips: "sharp-libvips-darwin-x64",
  },
  arm64: {
    binding: "sharp-darwin-arm64",
    libvips: "sharp-libvips-darwin-arm64",
  },
};

const APP_BUNDLE_PREFERRED_SUFFIXES_BY_HOST_ARCHITECTURE: Record<MacAppArchitecture, string[]> = {
  x64: [
    path.join("release", "mac-x64", APP_NAME),
    path.join("release", "mac", APP_NAME),
    path.join("release", "mac-universal", APP_NAME),
    path.join("release", "mac-arm64", APP_NAME),
  ],
  arm64: [
    path.join("release", "mac-arm64", APP_NAME),
    path.join("release", "mac-universal", APP_NAME),
    path.join("release", "mac", APP_NAME),
    path.join("release", "mac-x64", APP_NAME),
  ],
};

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

async function findAppBundles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    const entries = await listDirectoryEntries(dirPath);
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory() && entry.name === APP_NAME) {
        results.push(entryPath);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      }
    }
  }

  await walk(rootDir);
  return results;
}

function getHostMacAppArchitecture(): MacAppArchitecture {
  assert(
    process.arch === "x64" || process.arch === "arm64",
    `Unsupported macOS architecture for attach-file smoke test: ${process.arch}`
  );
  return process.arch;
}

function chooseDefaultAppBundle(appBundles: string[]): string {
  const preferredSuffixes =
    APP_BUNDLE_PREFERRED_SUFFIXES_BY_HOST_ARCHITECTURE[getHostMacAppArchitecture()];
  for (const suffix of preferredSuffixes) {
    const match = appBundles.find((appBundle) => appBundle.endsWith(suffix));
    if (match != null) {
      return match;
    }
  }

  return appBundles.sort()[0]!;
}

function toMacAppArchitecture(arch: string): MacAppArchitecture | null {
  if (arch === "x64" || arch === "x86_64") {
    return "x64";
  }
  if (arch === "arm64") {
    return "arm64";
  }
  return null;
}

function getPackagedAppArchitectures(appBundlePath: string): MacAppArchitecture[] {
  const executablePath = path.join(appBundlePath, "Contents", "MacOS", "mux");
  const result = spawnSync("lipo", ["-archs", executablePath], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert(result.error == null, `Failed to inspect macOS app architecture: ${result.error}`);
  assert(
    result.status === 0,
    `Failed to inspect macOS app architecture for ${executablePath}: ${result.stderr}`
  );

  const architectures = new Set<MacAppArchitecture>();
  for (const rawArch of result.stdout.trim().split(/\s+/)) {
    const architecture = toMacAppArchitecture(rawArch);
    if (architecture != null) {
      architectures.add(architecture);
    }
  }

  assert(
    architectures.size > 0,
    `No supported macOS architecture found for ${executablePath}: ${result.stdout}`
  );
  return MAC_APP_ARCHITECTURES.filter((architecture) => architectures.has(architecture));
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

async function assertDirectoryExists(dirPath: string, message: string): Promise<void> {
  const stat = await fs.stat(dirPath).catch(() => null);
  assert(stat?.isDirectory(), message);
}

async function verifyUnpackedSharpAssets(
  appBundlePath: string,
  architectures: MacAppArchitecture[]
): Promise<void> {
  const unpackedRoot = path.join(appBundlePath, "Contents", "Resources", "app.asar.unpacked");
  for (const segments of APP_ASAR_UNPACKED_NODE_MODULES) {
    const requiredPath = path.join(unpackedRoot, ...segments);
    await assertDirectoryExists(
      requiredPath,
      `Missing unpacked runtime directory: ${requiredPath}`
    );
  }

  const unpackedNodeModules = path.join(unpackedRoot, "node_modules");
  for (const architecture of architectures) {
    const packages = SHARP_RUNTIME_PACKAGES_BY_ARCHITECTURE[architecture];
    const sharpPackagePath = path.join(unpackedNodeModules, "@img", packages.binding);
    const libvipsPackagePath = path.join(unpackedNodeModules, "@img", packages.libvips);

    // Issue #3338: a generic "any sharp binary exists" check allowed the x64 app
    // to ship with only arm64 sharp assets. Assert the exact runtime packages for
    // each packaged architecture so Intel Macs cannot fail at startup again.
    await assertDirectoryExists(
      sharpPackagePath,
      `Missing ${architecture} sharp runtime package: ${sharpPackagePath}`
    );
    await assertDirectoryExists(
      libvipsPackagePath,
      `Missing ${architecture} libvips runtime package: ${libvipsPackagePath}`
    );

    const sharpBinaryPath = await findFileMatching(
      sharpPackagePath,
      new RegExp(`${packages.binding}\\.node$`)
    );
    assert(
      sharpBinaryPath != null,
      `Missing ${architecture} sharp native binary under ${sharpPackagePath}`
    );

    const libvipsPath = await findFileMatching(libvipsPackagePath, /libvips-cpp\..*\.dylib$/);
    assert(
      libvipsPath != null,
      `Missing ${architecture} libvips dylib under ${libvipsPackagePath}`
    );

    console.log(`[attach-file-smoke] ${architecture} unpacked sharp binary: ${sharpBinaryPath}`);
    console.log(`[attach-file-smoke] ${architecture} unpacked libvips dylib: ${libvipsPath}`);
  }
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

function runPackagedSmokeApp(
  appBundlePath: string,
  fixturePaths: { pngPath: string; jpegPath: string }
): void {
  const executablePath = path.join(appBundlePath, "Contents", "MacOS", "mux");
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

async function getDefaultAppBundles(): Promise<string[]> {
  const appBundles = await findAppBundles(RELEASE_DIR);
  assert(
    appBundles.length > 0,
    `No ${APP_NAME} found under ${RELEASE_DIR}. Run make dist-mac first.`
  );
  return appBundles;
}

async function verifyPackagedApp(appBundlePath: string): Promise<MacAppArchitecture[]> {
  const appStat = await fs.stat(appBundlePath).catch(() => null);
  assert(appStat?.isDirectory(), `macOS app bundle not found: ${appBundlePath}`);

  const architectures = getPackagedAppArchitectures(appBundlePath);
  console.log(
    `[attach-file-smoke] verifying app bundle ${appBundlePath} (${architectures.join(", ")})`
  );
  await verifyUnpackedSharpAssets(appBundlePath, architectures);
  return architectures;
}

async function main(): Promise<void> {
  assert(process.platform === "darwin", "checkMacAttachFileRuntime.ts only runs on macOS");

  const requestedAppBundle = process.argv[2];
  const appBundles =
    requestedAppBundle != null ? [requestedAppBundle] : await getDefaultAppBundles();
  const verifiedArchitectures = new Set<MacAppArchitecture>();
  for (const appBundlePath of appBundles) {
    for (const architecture of await verifyPackagedApp(appBundlePath)) {
      verifiedArchitectures.add(architecture);
    }
  }

  if (requestedAppBundle == null) {
    for (const architecture of MAC_APP_ARCHITECTURES) {
      assert(
        verifiedArchitectures.has(architecture),
        `No packaged ${architecture} ${APP_NAME} found under ${RELEASE_DIR}. Run make dist-mac first.`
      );
    }
  }

  const smokeAppBundlePath = requestedAppBundle ?? chooseDefaultAppBundle(appBundles);
  console.log(`[attach-file-smoke] running app smoke test with ${smokeAppBundlePath}`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-attach-file-smoke-"));
  try {
    const fixturePaths = await createFixtureImages(tempDir);
    runPackagedSmokeApp(smokeAppBundlePath, fixturePaths);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error("[attach-file-smoke] failed:", error);
  process.exitCode = 1;
});
