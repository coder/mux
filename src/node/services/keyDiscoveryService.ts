/**
 * Key Discovery Service — scans known AI tool config files for API keys.
 *
 * Used during onboarding to detect keys from Claude Code, Codex CLI,
 * aider, Continue.dev, and shell RC files, and offer to import them
 * into Mux's providers.jsonc.
 *
 * Security invariants:
 * - Full API keys are never returned to the frontend; only previews.
 * - Import writes to providers.jsonc with mode 0o600.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as jsonc from "jsonc-parser";
import type { Config } from "@/node/config";
import type { ProviderName } from "@/common/constants/providers";
import { log } from "@/node/services/log";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscoveredKey {
  /** Which Mux provider this key belongs to */
  provider: ProviderName;
  /** Human-readable source label, e.g. "Claude Code (~/.claude.json)" */
  source: string;
  /** Masked preview: first prefix + "…" + last 4 chars */
  keyPreview: string;
}

/**
 * Internal-only representation that includes the full key value.
 * Never serialised or sent across the IPC boundary.
 */
interface DiscoveredKeyInternal extends DiscoveredKey {
  fullKey: string;
}

/** Identifies a specific discovered key for import. */
export interface KeyImportRequest {
  provider: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Key masking
// ---------------------------------------------------------------------------

function maskKey(key: string): string {
  if (key.length <= 8) {
    return "****";
  }

  // Show recognisable prefix (e.g. "sk-ant-") + last 4 chars
  const prefixLen = Math.min(8, Math.floor(key.length / 3));
  return `${key.slice(0, prefixLen)}…${key.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Individual source scanners
// ---------------------------------------------------------------------------

async function readJsonSafe(filePath: string): Promise<unknown> {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return jsonc.parse(data);
  } catch {
    return undefined;
  }
}

async function readFileSafe(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Scan ~/.claude.json for Anthropic apiKey */
async function scanClaudeJson(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const filePath = path.join(home, ".claude.json");
  const parsed = (await readJsonSafe(filePath)) as { apiKey?: unknown } | undefined;

  if (parsed && isNonEmptyString(parsed.apiKey)) {
    results.push({
      provider: "anthropic",
      source: `Claude Code (~/.claude.json)`,
      keyPreview: maskKey(parsed.apiKey),
      fullKey: parsed.apiKey,
    });
  }

  return results;
}

/** Scan ~/.config/claude/settings.json for Anthropic apiKey */
async function scanClaudeSettings(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const filePath = path.join(home, ".config", "claude", "settings.json");
  const parsed = (await readJsonSafe(filePath)) as { apiKey?: unknown } | undefined;

  if (parsed && isNonEmptyString(parsed.apiKey)) {
    results.push({
      provider: "anthropic",
      source: `Claude Code (~/.config/claude/settings.json)`,
      keyPreview: maskKey(parsed.apiKey),
      fullKey: parsed.apiKey,
    });
  }

  return results;
}

/** Scan ~/.claude/.env for ANTHROPIC_API_KEY=... */
async function scanClaudeEnv(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const filePath = path.join(home, ".claude", ".env");
  const content = await readFileSafe(filePath);

  if (!content) {
    return results;
  }

  // Use global regex and iterate to find the *last* match, because later
  // assignments override earlier ones (key rotation appends new export).
  // Support both `ANTHROPIC_API_KEY=...` and `export ANTHROPIC_API_KEY=...`.
  const pattern = /^(?:export\s+)?ANTHROPIC_API_KEY=(.+)$/gm;
  let lastKey: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    // Strip surrounding quotes, then inline comments (# ...) and trailing semicolons
    const candidate = m[1]
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/\s+#.*$/, "")
      .replace(/;+$/, "");
    if (candidate) {
      lastKey = candidate;
    }
  }
  if (lastKey) {
    results.push({
      provider: "anthropic",
      source: `Claude Code (~/.claude/.env)`,
      keyPreview: maskKey(lastKey),
      fullKey: lastKey,
    });
  }

  return results;
}

/** Scan ~/.codex/ for OpenAI API keys */
async function scanCodexCli(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];

  for (const filename of ["config.json", "auth.json"]) {
    const filePath = path.join(home, ".codex", filename);
    const parsed = (await readJsonSafe(filePath)) as
      | { apiKey?: unknown; openai_api_key?: unknown }
      | undefined;

    if (!parsed) {
      continue;
    }

    const key = parsed.apiKey ?? parsed.openai_api_key;
    if (isNonEmptyString(key)) {
      results.push({
        provider: "openai",
        source: `Codex CLI (~/.codex/${filename})`,
        keyPreview: maskKey(key),
        fullKey: key,
      });
      break; // Only report the first Codex source
    }
  }

  return results;
}

/** Scan ~/.aider.conf.yml for API keys */
async function scanAiderConf(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const filePath = path.join(home, ".aider.conf.yml");
  const content = await readFileSafe(filePath);

  if (!content) {
    return results;
  }

  // Simple YAML key: value extraction (avoids YAML parser dependency)
  const keyMappings: Array<{ yamlKey: string; provider: ProviderName }> = [
    { yamlKey: "openai-api-key", provider: "openai" },
    { yamlKey: "anthropic-api-key", provider: "anthropic" },
  ];

  for (const mapping of keyMappings) {
    // Use global flag to find the *last* assignment (key rotation).
    const pattern = new RegExp(`^${mapping.yamlKey}\\s*:\\s*(.+)$`, "gm");
    let lastKey: string | null = null;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      // Strip surrounding quotes, then inline YAML comments (# ...)
      const candidate = m[1]
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\s+#.*$/, "");
      if (candidate) {
        lastKey = candidate;
      }
    }
    if (lastKey) {
      results.push({
        provider: mapping.provider,
        source: `aider (~/.aider.conf.yml)`,
        keyPreview: maskKey(lastKey),
        fullKey: lastKey,
      });
    }
  }

  return results;
}

/** Scan ~/.continue/config.json for provider API keys */
async function scanContinueDev(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const filePath = path.join(home, ".continue", "config.json");
  const parsed = (await readJsonSafe(filePath)) as
    | {
        models?: Array<{ provider?: unknown; apiKey?: unknown }>;
      }
    | undefined;

  if (!parsed || !Array.isArray(parsed.models)) {
    return results;
  }

  const providerMap: Record<string, ProviderName> = {
    anthropic: "anthropic",
    openai: "openai",
    google: "google",
  };
  const seen = new Set<ProviderName>();

  for (const model of parsed.models) {
    if (!model || typeof model !== "object") {
      continue;
    }

    const continueProvider = typeof model.provider === "string" ? model.provider.toLowerCase() : "";
    const muxProvider = providerMap[continueProvider];

    if (muxProvider && !seen.has(muxProvider) && isNonEmptyString(model.apiKey)) {
      seen.add(muxProvider);
      results.push({
        provider: muxProvider,
        source: `Continue.dev (~/.continue/config.json)`,
        keyPreview: maskKey(model.apiKey),
        fullKey: model.apiKey,
      });
    }
  }

  return results;
}

/** Scan shell RC files for exported API key env vars */
async function scanShellRcFiles(home: string): Promise<DiscoveredKeyInternal[]> {
  const results: DiscoveredKeyInternal[] = [];
  const rcFiles = [".bashrc", ".zshrc", ".profile", ".bash_profile"];

  const envVarMappings: Array<{ envVar: string; provider: ProviderName }> = [
    { envVar: "ANTHROPIC_API_KEY", provider: "anthropic" },
    { envVar: "OPENAI_API_KEY", provider: "openai" },
    { envVar: "GOOGLE_API_KEY", provider: "google" },
    { envVar: "GOOGLE_GENERATIVE_AI_API_KEY", provider: "google" },
    { envVar: "XAI_API_KEY", provider: "xai" },
    { envVar: "DEEPSEEK_API_KEY", provider: "deepseek" },
    { envVar: "OPENROUTER_API_KEY", provider: "openrouter" },
  ];

  // Track per-provider to only report first hit
  const seen = new Set<ProviderName>();

  for (const rcFile of rcFiles) {
    const filePath = path.join(home, rcFile);
    const content = await readFileSafe(filePath);
    if (!content) {
      continue;
    }

    for (const mapping of envVarMappings) {
      if (seen.has(mapping.provider)) {
        continue;
      }

      // Match: export VAR=value  or  export VAR="value"  or  export VAR='value'
      // Use global flag and iterate to find the *last* match, because later
      // shell assignments override earlier ones (key rotation appends a new export).
      const pattern = new RegExp(
        `^\\s*export\\s+${mapping.envVar}\\s*=\\s*["']?([^"'\\s#;]+)["']?`,
        "gm"
      );
      let lastKey: string | null = null;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(content)) !== null) {
        const candidate = m[1].trim();
        // Skip variable references like $OTHER_VAR
        if (candidate && !candidate.startsWith("$")) {
          lastKey = candidate;
        }
      }
      if (lastKey) {
        seen.add(mapping.provider);
        results.push({
          provider: mapping.provider,
          source: `Shell RC (~/${rcFile})`,
          keyPreview: maskKey(lastKey),
          fullKey: lastKey,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover API keys from other AI coding tools.
 * Returns preview-only data safe for the frontend.
 */
export async function discoverApiKeys(): Promise<DiscoveredKey[]> {
  const home = os.homedir();
  const internal = await discoverApiKeysInternal(home);

  // Strip fullKey before returning
  return internal.map(({ fullKey: _fullKey, ...rest }) => rest);
}

/**
 * Import a previously-discovered key into providers.jsonc.
 *
 * Re-scans the source to read the actual key value (never cached).
 * Returns true on success, error message on failure.
 */
export async function importDiscoveredKey(
  config: Config,
  request: KeyImportRequest
): Promise<{ success: true } | { success: false; error: string }> {
  const home = os.homedir();
  const allKeys = await discoverApiKeysInternal(home);

  const match = allKeys.find((k) => k.provider === request.provider && k.source === request.source);

  if (!match) {
    return {
      success: false,
      error: `Key not found for ${request.provider} from "${request.source}"`,
    };
  }

  try {
    // Load current providers config (or empty object)
    const providersConfig = config.loadProvidersConfig() ?? {};

    const provider = match.provider;
    providersConfig[provider] ??= {};

    const providerConfig = providersConfig[provider] as Record<string, unknown>;
    providerConfig.apiKey = match.fullKey;

    config.saveProvidersConfig(providersConfig);
    log.info("Imported API key", { provider, source: request.source });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("Failed to import API key", { provider: request.provider, error: message });
    return { success: false, error: `Failed to import key: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Full discovery with raw keys — only for import resolution. */
export async function discoverApiKeysInternal(home: string): Promise<DiscoveredKeyInternal[]> {
  const allKeys: DiscoveredKeyInternal[] = [];

  const scanners = [
    scanClaudeJson,
    scanClaudeSettings,
    scanClaudeEnv,
    scanCodexCli,
    scanAiderConf,
    scanContinueDev,
    scanShellRcFiles,
  ];

  for (const scanner of scanners) {
    try {
      const found = await scanner(home);
      allKeys.push(...found);
    } catch (err) {
      // Individual scanner failures should never break the whole flow
      log.warn("Key discovery scanner error", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Deduplicate: keep first occurrence per (provider, source)
  const seen = new Set<string>();
  return allKeys.filter((k) => {
    const id = `${k.provider}:${k.source}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}
