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

function shellQuoteCmd(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
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
 * bash tools resolve the vendored `agent-browser` binary instead of falling back
 * to a global install or `bunx`.
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

  const quotedPosixBinaryPath = shellQuotePosix(binaryPath);
  const quotedWindowsBinaryPath = shellQuoteCmd(binaryPath);

  // agent-browser gives CLI flags higher precedence than environment variables,
  // so the wrapper must inject the workspace session via --session and strip any
  // user-provided session flag to keep Browser tab state attached to one session.
  return {
    dir: getVendoredBinDir(),
    posixContent: [
      "#!/bin/sh",
      "# When AGENT_BROWSER_SESSION is set, force all agent-browser invocations to use",
      "# the workspace's deterministic session ID. We inject via the --session CLI flag",
      "# (which takes precedence over env vars) and strip any user-provided --session",
      "# to prevent session fragmentation outside the workspace's expected session.",
      'if [ -n "${AGENT_BROWSER_SESSION:-}" ]; then',
      "  mux_argc=$#",
      "  mux_i=0",
      '  while [ "$mux_i" -lt "$mux_argc" ]; do',
      '    mux_arg="$1"',
      "    shift",
      "    mux_i=$((mux_i + 1))",
      '    case "$mux_arg" in',
      "      --session)",
      "        # Skip this arg AND the next (the session value)",
      '        if [ "$mux_i" -lt "$mux_argc" ]; then',
      "          shift",
      "          mux_i=$((mux_i + 1))",
      "        fi",
      "        continue",
      "        ;;",
      "      --session=*)",
      "        continue",
      "        ;;",
      "    esac",
      '    set -- "$@" "$mux_arg"',
      "  done",
      `  exec ${quotedPosixBinaryPath} --session "$AGENT_BROWSER_SESSION" "$@"`,
      "fi",
      `exec ${quotedPosixBinaryPath} "$@"`,
      "",
    ].join("\n"),
    windowsContent: [
      "@echo off",
      "setlocal",
      "if not defined AGENT_BROWSER_SESSION (",
      `  ${quotedWindowsBinaryPath} %*`,
      "  exit /B",
      ")",
      'set "MUX_ARGS="',
      ":mux_loop",
      'if "%1"=="" goto mux_done',
      'set "MUX_CUR=%~1"',
      'if /I "%MUX_CUR%"=="--session" (',
      "  shift",
      "  shift",
      "  goto mux_loop",
      ")",
      'set "MUX_TEST=%MUX_CUR:~0,10%"',
      'if /I "%MUX_TEST%"=="--session=" (',
      "  shift",
      "  goto mux_loop",
      ")",
      'set "MUX_ARGS=%MUX_ARGS% %1"',
      "shift",
      "goto mux_loop",
      ":mux_done",
      `${quotedWindowsBinaryPath} --session "%AGENT_BROWSER_SESSION%" %MUX_ARGS%`,
      "exit /B",
      "",
    ].join("\r\n"),
  };
}
