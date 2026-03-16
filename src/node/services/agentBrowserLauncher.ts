import assert from "node:assert/strict";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getMuxHome } from "@/common/constants/paths";

const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const ARCH_ALIASES = {
  x64: "x64",
  x86_64: "x64",
  arm64: "arm64",
  aarch64: "arm64",
} as const;

type SupportedAgentBrowserPlatform = "darwin" | "linux" | "win32";
type SupportedAgentBrowserArch = (typeof ARCH_ALIASES)[keyof typeof ARCH_ALIASES];

interface ResolveAgentBrowserBinaryOptions {
  platform?: string;
  arch?: string;
  resolvePackageJsonPath?: (specifier: string) => string;
}

export class AgentBrowserUnsupportedPlatformError extends Error {
  constructor(platform: string, arch: string) {
    super(
      `Unsupported vendored agent-browser platform/arch combination: ${platform}-${arch}. Supported platforms: darwin, linux, win32. Supported architectures: x64, arm64.`
    );
    this.name = "AgentBrowserUnsupportedPlatformError";
  }
}

export class AgentBrowserVendoredPackageNotFoundError extends Error {
  constructor(cause: unknown) {
    super(
      `Vendored agent-browser package not found. Ensure the runtime dependency is installed so agent-browser/package.json can be resolved.`
    );
    this.name = "AgentBrowserVendoredPackageNotFoundError";
    this.cause = cause;
  }
}

export class AgentBrowserBinaryNotFoundError extends Error {
  constructor(binaryPath: string, platform: string, arch: string) {
    super(
      `Vendored agent-browser binary not found for ${platform}-${arch}. Expected executable at ${binaryPath}.`
    );
    this.name = "AgentBrowserBinaryNotFoundError";
  }
}

function normalizePlatform(platform: string): SupportedAgentBrowserPlatform | null {
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return null;
  }

  return platform as SupportedAgentBrowserPlatform;
}

function normalizeArch(arch: string): SupportedAgentBrowserArch | null {
  return ARCH_ALIASES[arch as keyof typeof ARCH_ALIASES] ?? null;
}

function getAgentBrowserBinaryName(platform: string, arch: string): string {
  const normalizedPlatform = normalizePlatform(platform);
  const normalizedArch = normalizeArch(arch);
  if (normalizedPlatform === null || normalizedArch === null) {
    throw new AgentBrowserUnsupportedPlatformError(platform, arch);
  }

  const extension = normalizedPlatform === "win32" ? ".exe" : "";
  return `agent-browser-${normalizedPlatform}-${normalizedArch}${extension}`;
}

function ensureExecutablePermission(binaryPath: string, platform: string): void {
  if (platform === "win32") {
    return;
  }

  try {
    accessSync(binaryPath, constants.X_OK);
  } catch {
    try {
      chmodSync(binaryPath, 0o755);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Vendored agent-browser binary exists but could not be made executable at ${binaryPath}: ${errorMessage}`
      );
    }
  }
}

function resolveAgentBrowserPackageRoot(
  resolvePackageJsonPath: (specifier: string) => string
): string {
  let packageJsonPath: string;
  try {
    packageJsonPath = resolvePackageJsonPath("agent-browser/package.json");
  } catch (error) {
    throw new AgentBrowserVendoredPackageNotFoundError(error);
  }

  const packageRoot = path.dirname(packageJsonPath);
  assert(packageRoot.length > 0, "Vendored agent-browser package root must be a non-empty path");
  assert(
    path.isAbsolute(packageRoot),
    "Vendored agent-browser package root must be an absolute path"
  );
  return packageRoot;
}

function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function rewriteAsarPath(inputPath: string): string {
  return inputPath.replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
}

export function getVendoredBinDir(): string {
  return path.join(getMuxHome(), "bin");
}

export function resolveAgentBrowserBinary(): string;
export function resolveAgentBrowserBinary(options: ResolveAgentBrowserBinaryOptions): string;
export function resolveAgentBrowserBinary(options?: ResolveAgentBrowserBinaryOptions): string {
  const runtimePlatform = options?.platform ?? process.platform;
  const runtimeArch = options?.arch ?? process.arch;
  const resolvePackageJsonPath = options?.resolvePackageJsonPath ?? require.resolve;

  const packageRoot = resolveAgentBrowserPackageRoot(resolvePackageJsonPath);
  const binaryName = getAgentBrowserBinaryName(runtimePlatform, runtimeArch);
  const binaryPath = rewriteAsarPath(path.join(packageRoot, "bin", binaryName));
  if (!existsSync(binaryPath)) {
    throw new AgentBrowserBinaryNotFoundError(binaryPath, runtimePlatform, runtimeArch);
  }

  ensureExecutablePermission(binaryPath, runtimePlatform);
  return binaryPath;
}

function prependPathOnce(dir: string, env: NodeJS.ProcessEnv): void {
  const existingPath = env.PATH ?? "";
  const pathEntries = existingPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (pathEntries.includes(dir)) {
    return;
  }

  env.PATH = existingPath.length > 0 ? `${dir}${path.delimiter}${existingPath}` : dir;
}

/**
 * Install the vendored agent-browser wrapper into mux-managed bin dir and ensure
 * the current process PATH can discover it. Server-mode mux needs this too so
 * bash tools resolve `agent-browser` instead of falling back to `bunx`, which
 * bypasses MUX_BROWSER_SESSION and leaves the Browser tab disconnected.
 */
export function materializeVendoredAgentBrowserWrapper(): void {
  const { dir, posixContent, windowsContent } = generateAgentBrowserWrapper();

  mkdirSync(dir, { recursive: true });

  const wrapperPath =
    process.platform === "win32"
      ? path.join(dir, "agent-browser.cmd")
      : path.join(dir, "agent-browser");
  writeFileSync(wrapperPath, process.platform === "win32" ? windowsContent : posixContent);

  if (process.platform !== "win32") {
    chmodSync(wrapperPath, 0o755);
  }

  process.env.MUX_VENDORED_BIN_DIR = dir;
  prependPathOnce(dir, process.env);
}

export function generateAgentBrowserWrapper(): {
  dir: string;
  posixContent: string;
  windowsContent: string;
} {
  const binaryPath = resolveAgentBrowserBinary();
  assert(
    path.isAbsolute(binaryPath),
    "Vendored agent-browser wrapper target must be an absolute path"
  );

  return {
    dir: getVendoredBinDir(),
    posixContent:
      `#!/bin/sh\n` +
      `mux_has_session_arg=0\n` +
      `for mux_arg in "$@"; do\n` +
      `  case "$mux_arg" in\n` +
      `    --session|--session=*)\n` +
      `      mux_has_session_arg=1\n` +
      `      break\n` +
      `      ;;\n` +
      `  esac\n` +
      `done\n` +
      `if [ "$mux_has_session_arg" -eq 0 ] && [ -n "\${MUX_BROWSER_SESSION:-}" ]; then\n` +
      `  exec ${shellQuotePosix(binaryPath)} --session "$MUX_BROWSER_SESSION" "$@"\n` +
      `fi\n` +
      `exec ${shellQuotePosix(binaryPath)} "$@"\n`,
    windowsContent:
      `@echo off\r\n` +
      `setlocal EnableDelayedExpansion\r\n` +
      `set "MUX_HAS_SESSION_ARG=0"\r\n` +
      `for %%A in (%*) do (\r\n` +
      `  set "MUX_CURRENT_ARG=%%~A"\r\n` +
      `  if /I "!MUX_CURRENT_ARG!"=="--session" set "MUX_HAS_SESSION_ARG=1"\r\n` +
      `  if /I "!MUX_CURRENT_ARG:~0,10!"=="--session=" set "MUX_HAS_SESSION_ARG=1"\r\n` +
      `)\r\n` +
      `if not "%MUX_BROWSER_SESSION%"=="" if "!MUX_HAS_SESSION_ARG!"=="0" (\r\n` +
      `  "${binaryPath.replaceAll('"', '""')}" --session "%MUX_BROWSER_SESSION%" %*\r\n` +
      `  exit /B !ERRORLEVEL!\r\n` +
      `)\r\n` +
      `"${binaryPath.replaceAll('"', '""')}" %*\r\n` +
      `exit /B !ERRORLEVEL!\r\n`,
  };
}
