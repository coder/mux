import assert from "./assert";

// Remote workspaces are represented locally via a namespaced workspaceId.
//
// Requirements:
// - Must be filesystem-safe across Windows/macOS/Linux (no path separators)
// - Must be reversible (decode(encode(x)) === x)
//
// We use base64url-encoded UTF-8 components separated by a `.` delimiter.
// base64url only uses [A-Za-z0-9_-], so `.` is a safe separator.
const REMOTE_WORKSPACE_ID_PREFIX = "remote.";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;

function toBase64(bytes: Uint8Array): string {
  // Prefer Node's Buffer when available (faster, fewer allocations).
  // Guarded for browser bundles.
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array | null {
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(base64, "base64"));
    }

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
  } catch {
    return null;
  }
}

function toBase64Url(base64: string): string {
  // Convert to RFC 4648 base64url (no padding)
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(base64Url: string): string | null {
  if (!base64UrlPattern.test(base64Url)) {
    return null;
  }

  const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = base64.length % 4;
  if (remainder === 1) {
    // Invalid base64 length.
    return null;
  }

  const padded = remainder === 0 ? base64 : base64 + "=".repeat(4 - remainder);
  return padded;
}

function encodeComponent(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return toBase64Url(toBase64(bytes));
}

function decodeComponent(value: string): string | null {
  const base64 = fromBase64Url(value);
  if (base64 === null) return null;

  const bytes = fromBase64(base64);
  if (bytes === null) return null;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function encodeRemoteWorkspaceId(serverId: string, remoteId: string): string {
  assert(typeof serverId === "string", "encodeRemoteWorkspaceId: serverId must be a string");
  assert(typeof remoteId === "string", "encodeRemoteWorkspaceId: remoteId must be a string");
  assert(serverId.length > 0, "encodeRemoteWorkspaceId: serverId must be non-empty");
  assert(remoteId.length > 0, "encodeRemoteWorkspaceId: remoteId must be non-empty");

  const encodedServerId = encodeComponent(serverId);
  const encodedRemoteId = encodeComponent(remoteId);

  // These should be impossible (base64url never includes '.') but we assert anyway to keep
  // the codec safe if the encoding strategy changes.
  assert(
    encodedServerId.length > 0 && !encodedServerId.includes("."),
    "encodeRemoteWorkspaceId: encoded serverId is invalid"
  );
  assert(
    encodedRemoteId.length > 0 && !encodedRemoteId.includes("."),
    "encodeRemoteWorkspaceId: encoded remoteId is invalid"
  );

  return `${REMOTE_WORKSPACE_ID_PREFIX}${encodedServerId}.${encodedRemoteId}`;
}

export function decodeRemoteWorkspaceId(id: string): { serverId: string; remoteId: string } | null {
  if (typeof id !== "string") return null;
  if (!id.startsWith(REMOTE_WORKSPACE_ID_PREFIX)) return null;

  const rest = id.slice(REMOTE_WORKSPACE_ID_PREFIX.length);
  const parts = rest.split(".");
  if (parts.length !== 2) return null;

  const [encodedServerId, encodedRemoteId] = parts;
  if (!encodedServerId || !encodedRemoteId) return null;

  const serverId = decodeComponent(encodedServerId);
  const remoteId = decodeComponent(encodedRemoteId);
  if (serverId === null || remoteId === null) return null;

  return { serverId, remoteId };
}

export function isRemoteWorkspaceId(id: string): boolean {
  return decodeRemoteWorkspaceId(id) !== null;
}
