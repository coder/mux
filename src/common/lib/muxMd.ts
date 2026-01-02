/**
 * mux.md Client Library
 *
 * End-to-end encrypted message sharing for Mux.
 * Messages are encrypted client-side before upload - the server never sees plaintext.
 */

export const MUX_MD_BASE_URL = "https://mux.md";
export const MUX_MD_HOST = "mux.md";
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 10; // 80 bits

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
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.slice(1); // Remove leading /
    const key = parsed.hash.slice(1); // Remove leading #
    if (!id || !key) return null;
    return { id, key };
  } catch {
    return null;
  }
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

export interface SignatureInfo {
  /** Base64-encoded Ed25519 signature */
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
  /** Signature info to include in frontmatter */
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

interface UploadMeta {
  salt: string;
  iv: string;
  encryptedMeta: string;
}

interface UploadResponse {
  id: string;
  url: string;
  mutateKey: string;
  expiresAt?: number;
}

// --- Crypto utilities ---

function base64UrlEncode(data: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...data));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64Encode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data));
}

function generateKey(): string {
  const bytes = new Uint8Array(KEY_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function generateSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

function generateIV(): Uint8Array {
  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);
  return iv;
}

async function deriveKey(keyMaterial: string, salt: Uint8Array): Promise<CryptoKey> {
  // Decode base64url key material
  let base64 = keyMaterial.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = atob(base64);
  const rawKey = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    rawKey[i] = binary.charCodeAt(i);
  }

  // Import as HKDF key material
  const baseKey = await crypto.subtle.importKey("raw", rawKey.buffer, "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);

  // Derive AES-256-GCM key using HKDF with SHA-256
  // Note: empty info array to match mux-md viewer
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      salt: salt.buffer as ArrayBuffer,
      info: new Uint8Array(0),
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    data.buffer as ArrayBuffer
  );
  return new Uint8Array(ciphertext);
}

async function decrypt(data: Uint8Array, key: CryptoKey, iv: Uint8Array): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    data.buffer as ArrayBuffer
  );
  return new Uint8Array(plaintext);
}

function base64Decode(str: string): Uint8Array {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// --- Signature utilities ---

/**
 * Prepend YAML frontmatter with signature info to content.
 * The signature is over the body only (original content), so we add frontmatter after signing.
 */
function addSignatureFrontmatter(content: string, sig: SignatureInfo): string {
  const lines = ["---", `mux_signature: ${sig.signature}`, `mux_public_key: ${sig.publicKey}`];
  if (sig.githubUser) {
    lines.push(`mux_github_user: ${sig.githubUser}`);
  }
  if (sig.email) {
    lines.push(`mux_email: ${sig.email}`);
  }
  lines.push("---", "", content);
  return lines.join("\n");
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
  // If signature is provided, prepend frontmatter
  const finalContent = options.signature
    ? addSignatureFrontmatter(content, options.signature)
    : content;
  const data = new TextEncoder().encode(finalContent);

  // Generate encryption parameters
  const keyMaterial = generateKey();
  const salt = generateSalt();
  const iv = generateIV();

  // Derive encryption key
  const cryptoKey = await deriveKey(keyMaterial, salt);

  // Encrypt file data
  const encryptedData = await encrypt(data, cryptoKey, iv);

  // Encrypt file metadata
  const metaJson = JSON.stringify(fileInfo);
  const metaBytes = new TextEncoder().encode(metaJson);
  const metaIv = generateIV();
  const encryptedMeta = await encrypt(metaBytes, cryptoKey, metaIv);

  // Prepare upload metadata
  const uploadMeta: UploadMeta = {
    salt: base64Encode(salt),
    iv: base64Encode(iv),
    encryptedMeta: base64Encode(new Uint8Array([...metaIv, ...encryptedMeta])),
  };

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "X-Mux-Meta": btoa(JSON.stringify(uploadMeta)),
  };

  // Add expiration header if specified
  if (options.expiresAt) {
    const expiresDate =
      options.expiresAt instanceof Date ? options.expiresAt : new Date(options.expiresAt);
    headers["X-Mux-Expires"] = expiresDate.toISOString();
  }

  // Upload to server
  const response = await fetch(`${MUX_MD_BASE_URL}/`, {
    method: "POST",
    headers,
    body: new Uint8Array(encryptedData) as BodyInit,
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: "Upload failed" }))) as {
      error?: string;
    };
    throw new Error(error.error ?? "Upload failed");
  }

  const result = (await response.json()) as UploadResponse;

  return {
    url: `${MUX_MD_BASE_URL}/${result.id}#${keyMaterial}`,
    id: result.id,
    key: keyMaterial,
    mutateKey: result.mutateKey,
    expiresAt: result.expiresAt,
  };
}

// --- Mutation API ---

interface MutateResponse {
  success: boolean;
  id: string;
  expiresAt?: number;
}

/**
 * Delete a shared file from mux.md.
 *
 * @param id - The file ID
 * @param mutateKey - The mutate key from upload
 */
export async function deleteFromMuxMd(id: string, mutateKey: string): Promise<void> {
  const response = await fetch(`${MUX_MD_BASE_URL}/${id}`, {
    method: "DELETE",
    headers: {
      "X-Mux-Mutate-Key": mutateKey,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: "Delete failed" }))) as {
      error?: string;
    };
    throw new Error(error.error ?? "Delete failed");
  }
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
  const expiresValue =
    expiresAt === "never"
      ? "never"
      : expiresAt instanceof Date
        ? expiresAt.toISOString()
        : expiresAt;

  const response = await fetch(`${MUX_MD_BASE_URL}/${id}`, {
    method: "PATCH",
    headers: {
      "X-Mux-Mutate-Key": mutateKey,
      "X-Mux-Expires": expiresValue,
    },
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ error: "Update failed" }))) as {
      error?: string;
    };
    throw new Error(error.error ?? "Update failed");
  }

  const result = (await response.json()) as MutateResponse;
  return result.expiresAt;
}

// --- Download API ---

export interface DownloadResult {
  /** Decrypted content */
  content: string;
  /** File metadata (if available) */
  fileInfo?: FileInfo;
}

interface MuxMdMeta {
  salt: string;
  iv: string;
  encryptedMeta: string;
}

/**
 * Download and decrypt content from mux.md.
 *
 * @param id - The file ID
 * @param keyMaterial - The encryption key (base64url encoded)
 * @param signal - Optional abort signal
 * @returns Decrypted content and metadata
 * @throws Error if download or decryption fails
 */
export async function downloadFromMuxMd(
  id: string,
  keyMaterial: string,
  signal?: AbortSignal
): Promise<DownloadResult> {
  const response = await fetch(`${MUX_MD_BASE_URL}/${id}`, {
    headers: { Accept: "application/octet-stream" },
    signal,
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Share link expired or not found");
    }
    throw new Error(`Failed to fetch: HTTP ${response.status}`);
  }

  // Get metadata from header
  const metaHeader = response.headers.get("X-Mux-Meta");
  if (!metaHeader) {
    throw new Error("Missing metadata header");
  }

  let meta: MuxMdMeta;
  try {
    meta = JSON.parse(atob(metaHeader)) as MuxMdMeta;
  } catch {
    throw new Error("Invalid metadata header");
  }

  // Decode encryption parameters
  const salt = base64Decode(meta.salt);
  const iv = base64Decode(meta.iv);

  if (salt.length !== SALT_BYTES || iv.length !== IV_BYTES) {
    throw new Error("Invalid encryption parameters");
  }

  // Derive decryption key
  const key = await deriveKey(keyMaterial, salt);

  // Get encrypted body
  const encryptedData = new Uint8Array(await response.arrayBuffer());

  // Decrypt content
  let content: string;
  try {
    const decrypted = await decrypt(encryptedData, key, iv);
    content = new TextDecoder().decode(decrypted);
  } catch (err) {
    throw new Error(
      `Decryption failed: ${err instanceof Error ? err.message : "invalid key or corrupted data"}`
    );
  }

  // Decrypt file metadata (optional - don't fail if this fails)
  let fileInfo: FileInfo | undefined;
  try {
    const encryptedMetaBytes = base64Decode(meta.encryptedMeta);
    // First 12 bytes are the IV for metadata
    const metaIv = encryptedMetaBytes.slice(0, IV_BYTES);
    const metaCiphertext = encryptedMetaBytes.slice(IV_BYTES);
    const decryptedMeta = await decrypt(metaCiphertext, key, metaIv);
    fileInfo = JSON.parse(new TextDecoder().decode(decryptedMeta)) as FileInfo;
  } catch {
    // Metadata decryption failed - continue without it
  }

  return { content, fileInfo };
}
