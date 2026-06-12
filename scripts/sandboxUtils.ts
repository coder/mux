import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

import { AZURE_OPENAI_ENV_VARS, PROVIDER_ENV_VARS } from "../src/node/utils/providerRequirements";

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

export type SeedSources = {
  providersPath: string | null;
  configPath: string | null;
};

/**
 * Pick seed files for a sandbox MUX_ROOT.
 *
 * providers.jsonc and config.json are chosen *independently* from the first
 * candidate root that has each file. A root like ~/.mux-dev often has only
 * config.json while provider credentials live in ~/.mux/providers.jsonc;
 * picking a single root would silently drop provider config and push the
 * sandboxed server onto env-var credential fallback, which can pair a real
 * API key with an unrelated *_BASE_URL proxy (e.g. Coder AI bridge) and fail
 * auth. See sanitizeSandboxProviderEnv for the env-side guard.
 */
export function chooseSeedSources(): SeedSources {
  const findFirstFile = (roots: string[], fileName: string): string | null => {
    for (const root of roots) {
      const candidate = path.join(root, fileName);
      if (fileExists(candidate)) return candidate;
    }
    return null;
  };

  if (process.env.SEED_MUX_ROOT) {
    const explicit = expandTilde(process.env.SEED_MUX_ROOT);
    if (!dirExists(explicit)) {
      throw new Error(`SEED_MUX_ROOT does not exist or is not a directory: ${explicit}`);
    }
    // Explicit seed root: only look there.
    return {
      providersPath: findFirstFile([explicit], "providers.jsonc"),
      configPath: findFirstFile([explicit], "config.json"),
    };
  }

  const candidates = [
    process.env.MUX_ROOT ? expandTilde(process.env.MUX_ROOT) : null,
    path.join(os.homedir(), ".mux-dev"),
    path.join(os.homedir(), ".mux"),
  ].filter((value): value is string => Boolean(value));

  return {
    providersPath: findFirstFile(candidates, "providers.jsonc"),
    configPath: findFirstFile(candidates, "config.json"),
  };
}

/**
 * Env vars that mux's provider-credential resolution reads as fallback
 * (API keys / auth tokens, base URLs, org IDs, Azure OpenAI vars).
 *
 * Intentionally excludes shared AWS env vars (AWS_REGION etc.): stripping
 * those would break unrelated AWS tooling spawned inside the sandbox, and
 * Bedrock auth goes through the AWS SDK chain rather than key+baseUrl pairing.
 */
function providerCredentialEnvVarNames(): string[] {
  const names = new Set<string>();
  for (const mapping of Object.values(PROVIDER_ENV_VARS)) {
    for (const key of [
      ...(mapping.apiKey ?? []),
      ...(mapping.baseUrl ?? []),
      ...(mapping.organization ?? []),
    ]) {
      names.add(key);
    }
  }
  for (const key of Object.values(AZURE_OPENAI_ENV_VARS)) {
    names.add(key);
  }
  return [...names];
}

/**
 * Build the child env for a sandboxed mux instance, guarding against provider
 * env-var fallback surprises:
 *
 * - `--clean-providers`: strip all provider credential env vars so the sandbox
 *   is actually clean (otherwise the server silently falls back to env keys,
 *   and a *_BASE_URL pointing at a proxy/AI-bridge can mismatch the env key).
 * - providers.jsonc not seeded (none found): keep env vars (env-only setups
 *   are legitimate) but warn loudly about the fallback + base-URL pairing risk.
 */
export function sanitizeSandboxProviderEnv(options: {
  cleanProviders: boolean;
  copiedProviders: boolean;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const present = providerCredentialEnvVarNames()
    .filter((name) => (env[name] ?? "").trim() !== "")
    .sort();

  if (options.cleanProviders) {
    for (const name of present) {
      delete env[name];
    }
    if (present.length > 0) {
      console.log(`  Stripped provider env vars (--clean-providers): ${present.join(", ")}`);
    }
    return env;
  }

  if (!options.copiedProviders && present.length > 0) {
    console.warn(
      `\nWARNING: no providers.jsonc was seeded into the sandbox; the server will fall back to provider env vars: ${present.join(", ")}.\n` +
        "If a *_BASE_URL env var points at a proxy (e.g. Coder AI bridge), the env API key may not match it and provider auth will fail.\n"
    );
  }

  return env;
}

export function copyConfigClearingProjectsIfExists(sourcePath: string, destPath: string): boolean {
  if (!fileExists(sourcePath)) return false;

  function sanitizeConfig(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { projects: [] };
    }

    return { ...(value as Record<string, unknown>), projects: [] };
  }

  let parsed: unknown;
  try {
    const raw = fs.readFileSync(sourcePath, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`Failed to read/parse config.json at ${sourcePath}:`, err);
    parsed = null;
  }

  const sanitized = sanitizeConfig(parsed);

  try {
    fs.writeFileSync(destPath, JSON.stringify(sanitized, null, 2));
    return true;
  } catch (err) {
    console.warn(`Failed to write config.json at ${destPath}:`, err);
    return false;
  }
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
