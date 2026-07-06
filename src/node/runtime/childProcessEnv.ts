import * as path from "node:path";
import { getMuxHome } from "@/common/constants/paths";

const CHILD_ENV_KEYS_TO_STRIP = [
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_STREAM_PORT",
  "MUX_VENDORED_BIN_DIR",
  // Linux desktop identity (app_id source). Electron sets it in our process env
  // (from package.json desktopName, or main.ts for launch modes without a
  // package.json). Chromium/Electron apps launched from a mux terminal would
  // inherit it and group under mux's taskbar entry.
  "CHROME_DESKTOP",
] as const;

function normalizePathEntry(entry: string): string {
  const resolved = path.resolve(entry);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function getMuxVendoredBinDirs(env: NodeJS.ProcessEnv): string[] {
  const candidates = [env.MUX_VENDORED_BIN_DIR, path.join(getMuxHome(), "bin")];
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => normalizePathEntry(value.trim()));
}

export function sanitizeMuxChildPath(
  pathValue: string | undefined,
  env: NodeJS.ProcessEnv
): string | undefined {
  if (pathValue == null) {
    return pathValue;
  }

  const vendoredBinDirs = getMuxVendoredBinDirs(env);
  if (vendoredBinDirs.length === 0) {
    return pathValue;
  }

  const sanitizedEntries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !vendoredBinDirs.includes(normalizePathEntry(entry)));

  return sanitizedEntries.join(path.delimiter);
}

export function sanitizeMuxChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitizedEnv: NodeJS.ProcessEnv = { ...env };
  const sanitizedPath = sanitizeMuxChildPath(env.PATH ?? env.Path, env);

  for (const key of CHILD_ENV_KEYS_TO_STRIP) {
    delete sanitizedEnv[key];
  }

  if (sanitizedPath !== undefined) {
    sanitizedEnv.PATH = sanitizedPath;
    sanitizedEnv.Path = sanitizedPath;
  }

  return sanitizedEnv;
}
