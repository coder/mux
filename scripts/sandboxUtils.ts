import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

function dirExists(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function chooseSeedMuxRoot(): string | null {
  if (process.env.SEED_MUX_ROOT) {
    const explicit = expandTilde(process.env.SEED_MUX_ROOT);
    if (!dirExists(explicit)) {
      throw new Error(`SEED_MUX_ROOT does not exist or is not a directory: ${explicit}`);
    }
    return explicit;
  }

  const candidates = [
    process.env.MUX_ROOT ? expandTilde(process.env.MUX_ROOT) : null,
    path.join(os.homedir(), ".mux-dev"),
    path.join(os.homedir(), ".mux"),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (!dirExists(candidate)) continue;

    const hasProviders = fileExists(path.join(candidate, "providers.jsonc"));
    const hasConfig = fileExists(path.join(candidate, "config.json"));

    if (hasProviders || hasConfig) return candidate;
  }

  for (const candidate of candidates) {
    if (dirExists(candidate)) return candidate;
  }

  return null;
}

export function copyFileIfExists(
  sourcePath: string,
  destPath: string,
  options?: { mode?: number }
): boolean {
  if (!fileExists(sourcePath)) return false;

  fs.copyFileSync(sourcePath, destPath);

  if (options?.mode !== undefined) {
    try {
      fs.chmodSync(destPath, options.mode);
    } catch {
      // Best-effort on platforms that support POSIX permissions.
    }
  }

  return true;
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();

    server.on("error", reject);

    // Bind to loopback since dev-server defaults to 127.0.0.1.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve free port")));
        return;
      }

      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });

    // If the script gets interrupted, don't keep the process alive because of this server.
    server.unref();
  });
}

export function parseOptionalPort(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

export async function waitForHttpReady(
  urlOrUrls: string | string[],
  timeoutMs = 20_000
): Promise<void> {
  const urls = Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls];

  if (!urls.length) {
    throw new Error("Expected at least one url");
  }

  for (const url of urls) {
    if (!url) {
      throw new Error("Expected url");
    }
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const url of urls) {
      try {
        const response = await fetch(url, { method: "GET" });
        if (response.ok || response.status === 404) {
          return;
        }
      } catch {
        // Server not ready yet
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const renderedUrls = urls.length === 1 ? urls[0] : urls.join(", ");
  throw new Error(`Timed out waiting for server at ${renderedUrls}`);
}

/**
 * Forward SIGINT/SIGTERM so Ctrl+C stops all subprocesses.
 *
 * Prefer passing a getter (vs a static array) so callers can register once
 * while processes are spawned later.
 */
export function forwardSignalsToChildProcesses(
  getChildren: () => Array<ChildProcess | null | undefined>
): void {
  const forwardSignal = (signal: NodeJS.Signals): void => {
    for (const child of getChildren()) {
      if (!child) continue;
      if (child.exitCode !== null) continue;
      if (!child.killed) {
        child.kill(signal);
      }
    }
  };

  process.on("SIGINT", () => forwardSignal("SIGINT"));
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
}
