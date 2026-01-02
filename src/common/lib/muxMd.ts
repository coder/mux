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
  type SignatureEnvelope,
  type UploadResult,
} from "@coder/mux-md-client";

// Re-export types from package
export type { FileInfo, UploadResult };

export const MUX_MD_BASE_URL = "https://mux.md";
export const MUX_MD_HOST = "mux.md";

// --- URL utilities ---

/**
 * Check if URL is a mux.md share link with encryption key in fragment
 */
export function isMuxMdUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === MUX_MD_HOST && parseUrl(url) !== null;
  } catch {
    return false;
  }
}

/**
 * Parse mux.md URL to extract ID and key
 */
export function parseMuxMdUrl(url: string): { id: string; key: string } | null {
  return parseUrl(url);
}

/**
 * Signature info for mux.md uploads.
 * Maps to the package's SignatureEnvelope with field name compatibility.
 */
export interface SignatureInfo {
  /** Base64-encoded signature */
  signature: string;
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...) */
  publicKey: string;
  /** GitHub username, if detected */
  githubUser?: string;
  /** Email address as fallback identity */
  email?: string;
}

export interface UploadOptions {
  /** Expiration time (ISO date string or Date object) */
  expiresAt?: string | Date;
  /** Signature info to include */
  signature?: SignatureInfo;
}

/** Convert our SignatureInfo to package's SignatureEnvelope */
function toSignatureEnvelope(sig: SignatureInfo): SignatureEnvelope {
  return {
    sig: sig.signature,
    publicKey: sig.publicKey,
    githubUser: sig.githubUser,
    email: sig.email,
  };
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
    baseUrl: MUX_MD_BASE_URL,
    expiresAt: options.expiresAt,
    signature: options.signature ? toSignatureEnvelope(options.signature) : undefined,
  });
}

/**
 * Delete a shared file from mux.md.
 */
export async function deleteFromMuxMd(id: string, mutateKey: string): Promise<void> {
  await deleteFile(id, mutateKey, { baseUrl: MUX_MD_BASE_URL });
}

/**
 * Update expiration of a shared file on mux.md.
 */
export async function updateMuxMdExpiration(
  id: string,
  mutateKey: string,
  expiresAt: Date | string
): Promise<number | undefined> {
  const result = await setExpiration(id, mutateKey, expiresAt, { baseUrl: MUX_MD_BASE_URL });
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
  _signal?: AbortSignal
): Promise<DownloadResult> {
  const result = await download(id, keyMaterial, { baseUrl: MUX_MD_BASE_URL });
  return {
    content: new TextDecoder().decode(result.data),
    fileInfo: result.info,
  };
}
