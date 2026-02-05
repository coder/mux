/**
 * mux.md Client Library
 *
 * Thin wrapper around @coder/mux-md-client for Mux app integration.
 * Re-exports types and provides convenience functions with default base URL.
 */

import {
  upload,
  download,
  deleteFile,
  setExpiration,
  parseUrl,
  type FileInfo,
  type SignOptions,
  type SignatureEnvelope,
  type UploadResult,
} from "@coder/mux-md-client";

// Re-export types from package
export type { FileInfo, SignOptions, SignatureEnvelope, UploadResult };

export const MUX_MD_BASE_URL = "https://mux.md";
export const MUX_MD_HOST = "mux.md";

function getMuxMdUrlOverrideRaw(): string | undefined {
  // In Electron, we expose the env var via preload so the renderer doesn't need `process.env`.
  if (typeof window !== "undefined") {
    const fromPreload = window.api?.muxMdUrlOverride;
    if (fromPreload && fromPreload.trim().length > 0) return fromPreload;

    // In dev-server browser mode (no Electron preload), Vite injects the env var into the bundle.
    const fromViteDefine = globalThis.__MUX_MD_URL_OVERRIDE__;
    if (fromViteDefine && fromViteDefine.trim().length > 0) return fromViteDefine;

    // Important: avoid falling back to `process.env` in the renderer bundle.
    return undefined;
  }

  // In Node (main process / tests), read directly from the environment.
  const fromEnv = globalThis.process?.env?.MUX_MD_URL_OVERRIDE;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  return undefined;
}

function normalizeMuxMdBaseUrlOverride(raw: string): string | undefined {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/**
 * Returns the effective mux.md base URL.
 *
 * Supports a runtime override (via `MUX_MD_URL_OVERRIDE`) so we can test against staging/local mux.md
 * deployments without rebuilding the renderer bundle.
 */
export function getMuxMdBaseUrl(): string {
  const overrideRaw = getMuxMdUrlOverrideRaw();
  const override = overrideRaw ? normalizeMuxMdBaseUrlOverride(overrideRaw) : undefined;
  return override ?? MUX_MD_BASE_URL;
}

/**
 * Hosts that should be treated as mux.md share links.
 *
 * Even when an override is set, we still allow the production host so existing share links keep
 * working.
 */
export function getMuxMdAllowedHosts(): string[] {
  const hosts = new Set<string>();
  hosts.add(MUX_MD_HOST);

  try {
    hosts.add(new URL(getMuxMdBaseUrl()).host);
  } catch {
    // Best-effort: getMuxMdBaseUrl() should always be a valid URL.
  }

  return [...hosts];
}

// --- URL utilities ---

/**
 * Check if URL is a mux.md share link with encryption key in fragment
 */
export function isMuxMdUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return getMuxMdAllowedHosts().includes(parsed.host) && parseUrl(url) !== null;
  } catch {
    return false;
  }
}

/**
 * Parse a mux.md share URL to extract ID and key.
 *
 * Note: `parseUrl` does not validate the host; call `isMuxMdUrl()` when validating user input.
 */
export function parseMuxMdUrl(url: string): { id: string; key: string } | null {
  return parseUrl(url);
}

export interface UploadOptions {
  /** Expiration time (ISO date string or Date object) */
  expiresAt?: string | Date;
  /**
   * Precomputed signature envelope to embed in the encrypted payload.
   * Takes precedence over `sign`.
   */
  signature?: SignatureEnvelope;
  /** Sign options for native signing via mux-md-client */
  sign?: SignOptions;
}

// --- Public API ---

/**
 * Upload content to mux.md with end-to-end encryption.
 */
export async function uploadToMuxMd(
  content: string,
  fileInfo: FileInfo,
  options: UploadOptions = {}
): Promise<UploadResult> {
  return upload(new TextEncoder().encode(content), fileInfo, {
    baseUrl: getMuxMdBaseUrl(),
    expiresAt: options.expiresAt,
    signature: options.signature,
    sign: options.sign,
  });
}

/**
 * Delete a shared file from mux.md.
 */
export async function deleteFromMuxMd(id: string, mutateKey: string): Promise<void> {
  await deleteFile(id, mutateKey, { baseUrl: getMuxMdBaseUrl() });
}

/**
 * Update expiration of a shared file on mux.md.
 */
export async function updateMuxMdExpiration(
  id: string,
  mutateKey: string,
  expiresAt: Date | string
): Promise<number | undefined> {
  const result = await setExpiration(id, mutateKey, expiresAt, { baseUrl: getMuxMdBaseUrl() });
  return result.expiresAt;
}

// --- Download API ---

export interface DownloadResult {
  /** Decrypted content */
  content: string;
  /** File metadata (if available) */
  fileInfo?: FileInfo;
}

/**
 * Download and decrypt content from mux.md.
 */
export async function downloadFromMuxMd(
  id: string,
  keyMaterial: string,
  _signal?: AbortSignal,
  options?: {
    baseUrl?: string;
  }
): Promise<DownloadResult> {
  const result = await download(id, keyMaterial, {
    baseUrl: options?.baseUrl ?? getMuxMdBaseUrl(),
  });
  return {
    content: new TextDecoder().decode(result.data),
    fileInfo: result.info,
  };
}
