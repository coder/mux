/**
 * mux.md Client Library
 *
 * Thin wrapper around @coder/mux-md-client with Mux-specific types and utilities.
 * The underlying package handles encryption, upload/download, and signature verification.
 */

import {
  upload as clientUpload,
  download as clientDownload,
  deleteFile as clientDelete,
  setExpiration as clientSetExpiration,
  parseUrl,
  type FileInfo as ClientFileInfo,
  type SignatureEnvelope,
  type UploadResult as ClientUploadResult,
} from "@coder/mux-md-client";

export const MUX_MD_BASE_URL = "https://mux.md";
export const MUX_MD_HOST = "mux.md";

// --- URL utilities ---

/**
 * Check if URL is a mux.md share link with encryption key in fragment
 */
export function isMuxMdUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === MUX_MD_HOST && parsed.hash.length > 1;
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
 * File metadata encrypted client-side
 */
export interface FileInfo {
  name: string;
  type: string;
  size: number;
  model?: string;
  thinking?: string;
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

export interface UploadResult {
  /** Full URL with encryption key in fragment */
  url: string;
  /** File ID (without key) */
  id: string;
  /** Encryption key (base64url) */
  key: string;
  /** Mutate key (base64url) - store this to delete or update expiration */
  mutateKey: string;
  /** Expiration timestamp (ms), if set */
  expiresAt?: number;
}

// --- Conversion utilities ---

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
 *
 * @param content - The markdown content to share
 * @param fileInfo - Metadata about the content (name, model, thinking level)
 * @param options - Upload options (expiration, signature, etc.)
 * @returns Upload result with shareable URL
 */
export async function uploadToMuxMd(
  content: string,
  fileInfo: FileInfo,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const data = new TextEncoder().encode(content);

  const result: ClientUploadResult = await clientUpload(data, fileInfo as ClientFileInfo, {
    baseUrl: MUX_MD_BASE_URL,
    expiresAt: options.expiresAt,
    signature: options.signature ? toSignatureEnvelope(options.signature) : undefined,
  });

  return {
    url: result.url,
    id: result.id,
    key: result.key,
    mutateKey: result.mutateKey,
    expiresAt: result.expiresAt,
  };
}

/**
 * Delete a shared file from mux.md.
 *
 * @param id - The file ID
 * @param mutateKey - The mutate key from upload
 */
export async function deleteFromMuxMd(id: string, mutateKey: string): Promise<void> {
  await clientDelete(id, mutateKey, { baseUrl: MUX_MD_BASE_URL });
}

/**
 * Update expiration of a shared file on mux.md.
 *
 * @param id - The file ID
 * @param mutateKey - The mutate key from upload
 * @param expiresAt - New expiration (Date, ISO string, or "never" to remove expiration)
 * @returns The new expiration timestamp (undefined if set to "never")
 */
export async function updateMuxMdExpiration(
  id: string,
  mutateKey: string,
  expiresAt: Date | string
): Promise<number | undefined> {
  const result = await clientSetExpiration(id, mutateKey, expiresAt, { baseUrl: MUX_MD_BASE_URL });
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
 *
 * @param id - The file ID
 * @param keyMaterial - The encryption key (base64url encoded)
 * @param _signal - Optional abort signal (not currently used by underlying client)
 * @returns Decrypted content and metadata
 * @throws Error if download or decryption fails
 */
export async function downloadFromMuxMd(
  id: string,
  keyMaterial: string,
  _signal?: AbortSignal
): Promise<DownloadResult> {
  const result = await clientDownload(id, keyMaterial, { baseUrl: MUX_MD_BASE_URL });

  return {
    content: new TextDecoder().decode(result.data),
    fileInfo: result.info as FileInfo,
  };
}
