/**
 * Signing Service
 *
 * Provides Ed25519 message signing for mux.md.
 * - Loads Ed25519 key from ~/.mux/id_ed25519 or ~/.ssh/id_ed25519
 * - Signs content with private key
 * - Returns public key in OpenSSH format
 * - Detects GitHub username via `gh auth status`
 */

import { createPrivateKey, createPublicKey, sign } from "crypto";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { execAsync } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";

interface KeyPair {
  privateKey: Buffer;
  publicKeyOpenSSH: string;
}

interface GitHubStatus {
  username: string | null;
  error: string | null;
}

interface SigningCapabilities {
  /** Whether signing is available */
  available: boolean;
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...) */
  publicKey: string | null;
  /** Detected GitHub username, if any */
  githubUser: string | null;
  /** Error message if GitHub user detection failed */
  githubError: string | null;
}

interface SignResult {
  /** Base64-encoded Ed25519 signature (64 bytes) */
  signature: string;
  /** Public key in OpenSSH format */
  publicKey: string;
  /** Detected GitHub username, if any */
  githubUser: string | null;
}

/** Paths to check for Ed25519 keys, in order of preference */
const KEY_PATHS = [join(homedir(), ".mux", "id_ed25519"), join(homedir(), ".ssh", "id_ed25519")];

/**
 * Service for Ed25519 message signing.
 * Loads key from ~/.mux/id_ed25519 or ~/.ssh/id_ed25519 on first use.
 */
export class SigningService {
  private keyPair: KeyPair | null = null;
  private keyLoadAttempted = false;
  private keyLoadError: string | null = null;
  private githubStatusCache: GitHubStatus | null = null;
  private githubStatusPromise: Promise<GitHubStatus> | null = null;

  /**
   * Load the Ed25519 keypair from disk.
   * Tries ~/.mux/id_ed25519 first, then ~/.ssh/id_ed25519.
   * Supports both PEM (PKCS8) and OpenSSH private key formats.
   * Returns null if no Ed25519 key is found.
   */
  private loadKeyPair(): KeyPair | null {
    if (this.keyLoadAttempted) return this.keyPair;
    this.keyLoadAttempted = true;

    for (const keyPath of KEY_PATHS) {
      if (!existsSync(keyPath)) continue;

      try {
        log.info("[SigningService] Attempting to load key from:", keyPath);
        const keyData = readFileSync(keyPath, "utf-8");

        // Detect format and parse accordingly
        if (keyData.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
          // OpenSSH format - parse manually
          const parsed = this.parseOpenSSHPrivateKey(keyData);
          if (!parsed) {
            log.info("[SigningService] Failed to parse OpenSSH key at", keyPath);
            continue;
          }
          if (parsed.keyType !== "ssh-ed25519") {
            log.info(
              "[SigningService] Key at",
              keyPath,
              "is",
              parsed.keyType,
              "not ssh-ed25519, skipping"
            );
            continue;
          }

          // For Ed25519, the private key is 64 bytes (seed + public key) in OpenSSH format
          // We need the first 32 bytes (the seed/private key)
          const rawPrivateKey = parsed.privateKey.slice(0, 32);
          const openSSHKey = this.rawToOpenSSH(parsed.publicKey);

          this.keyPair = {
            privateKey: rawPrivateKey,
            publicKeyOpenSSH: openSSHKey,
          };

          log.info("[SigningService] Loaded Ed25519 key (OpenSSH format) from:", keyPath);
          log.info("[SigningService] Public key:", openSSHKey.slice(0, 50) + "...");
          return this.keyPair;
        }

        // PEM/PKCS8 format
        const privateKey = createPrivateKey({
          key: keyData,
          format: "pem",
        });

        // Verify it's Ed25519
        if (privateKey.asymmetricKeyType !== "ed25519") {
          log.info(
            "[SigningService] Key at",
            keyPath,
            "is",
            privateKey.asymmetricKeyType,
            "not ed25519, skipping"
          );
          continue;
        }

        // Extract raw private key (32 bytes)
        const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });
        const rawPrivateKey = Buffer.from(privateKeyDer.slice(-32));

        // Derive public key and convert to OpenSSH format
        const pubKey = createPublicKey(privateKey);
        const openSSHKey = this.derToOpenSSH(pubKey.export({ type: "spki", format: "der" }));

        this.keyPair = {
          privateKey: rawPrivateKey,
          publicKeyOpenSSH: openSSHKey,
        };

        log.info("[SigningService] Loaded Ed25519 key (PEM format) from:", keyPath);
        log.info("[SigningService] Public key:", openSSHKey.slice(0, 50) + "...");
        return this.keyPair;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("[SigningService] Failed to load key from", keyPath + ":", message);
        // Continue to next path
      }
    }

    this.keyLoadError = `No Ed25519 key found. Checked: ${KEY_PATHS.join(", ")}`;
    log.info("[SigningService]", this.keyLoadError);
    return null;
  }

  /**
   * Parse an OpenSSH private key file.
   * Returns the key type, public key, and private key as Buffers.
   */
  private parseOpenSSHPrivateKey(
    keyData: string
  ): { keyType: string; publicKey: Buffer; privateKey: Buffer } | null {
    try {
      // Remove header/footer and decode base64
      const lines = keyData.split("\n");
      const base64 = lines.filter((line) => !line.startsWith("-----")).join("");
      const data = Buffer.from(base64, "base64");

      // OpenSSH private key format:
      // "openssh-key-v1" + null byte
      // cipher name (string)
      // kdf name (string)
      // kdf options (string)
      // number of keys (uint32)
      // public key blob (string)
      // private key blob (string) - encrypted or not

      let offset = 0;

      // Check magic
      const magic = "openssh-key-v1\0";
      if (data.toString("utf-8", 0, magic.length) !== magic) {
        return null;
      }
      offset += magic.length;

      // Read cipher name
      const cipherLen = data.readUInt32BE(offset);
      offset += 4;
      const cipher = data.toString("utf-8", offset, offset + cipherLen);
      offset += cipherLen;

      // We only support unencrypted keys
      if (cipher !== "none") {
        log.info("[SigningService] Encrypted SSH key not supported (cipher:", cipher + ")");
        return null;
      }

      // Read kdf name
      const kdfLen = data.readUInt32BE(offset);
      offset += 4;
      offset += kdfLen; // skip kdf name

      // Read kdf options
      const kdfOptionsLen = data.readUInt32BE(offset);
      offset += 4;
      offset += kdfOptionsLen; // skip kdf options

      // Read number of keys
      const numKeys = data.readUInt32BE(offset);
      offset += 4;

      if (numKeys !== 1) {
        log.info("[SigningService] Multiple keys in file not supported");
        return null;
      }

      // Read public key blob
      const pubKeyBlobLen = data.readUInt32BE(offset);
      offset += 4;
      const pubKeyBlob = data.slice(offset, offset + pubKeyBlobLen);
      offset += pubKeyBlobLen;

      // Parse public key blob to get key type
      let pubOffset = 0;
      const keyTypeLen = pubKeyBlob.readUInt32BE(pubOffset);
      pubOffset += 4;
      const keyType = pubKeyBlob.toString("utf-8", pubOffset, pubOffset + keyTypeLen);
      pubOffset += keyTypeLen;

      // Read the raw public key from the blob
      const rawPubKeyLen = pubKeyBlob.readUInt32BE(pubOffset);
      pubOffset += 4;
      const rawPublicKey = pubKeyBlob.slice(pubOffset, pubOffset + rawPubKeyLen);

      // Read private key section
      const privSectionLen = data.readUInt32BE(offset);
      offset += 4;
      const privSection = data.slice(offset, offset + privSectionLen);

      // Private section format:
      // checkint (uint32) - random, must match
      // checkint (uint32) - same value
      // key type (string)
      // public key (string)
      // private key (string) - for ed25519, 64 bytes (seed + pub)
      // comment (string)
      // padding

      let privOffset = 0;

      // Skip checkints
      privOffset += 8;

      // Read key type again
      const privKeyTypeLen = privSection.readUInt32BE(privOffset);
      privOffset += 4;
      privOffset += privKeyTypeLen;

      // Read public key in private section
      const privPubKeyLen = privSection.readUInt32BE(privOffset);
      privOffset += 4;
      privOffset += privPubKeyLen;

      // Read private key
      const privKeyLen = privSection.readUInt32BE(privOffset);
      privOffset += 4;
      const rawPrivateKey = privSection.slice(privOffset, privOffset + privKeyLen);

      return { keyType, publicKey: rawPublicKey, privateKey: rawPrivateKey };
    } catch {
      return null;
    }
  }

  /**
   * Convert raw 32-byte public key to OpenSSH format.
   */
  private rawToOpenSSH(rawPublicKey: Buffer): string {
    const keyType = "ssh-ed25519";
    const keyTypeLength = Buffer.alloc(4);
    keyTypeLength.writeUInt32BE(keyType.length);

    const keyDataLength = Buffer.alloc(4);
    keyDataLength.writeUInt32BE(rawPublicKey.length);

    const blob = Buffer.concat([keyTypeLength, Buffer.from(keyType), keyDataLength, rawPublicKey]);

    return `ssh-ed25519 ${blob.toString("base64")}`;
  }

  /**
   * Convert SPKI DER format public key to OpenSSH format.
   */
  private derToOpenSSH(spkiDer: Buffer): string {
    // SPKI DER for Ed25519 has 12 bytes prefix, raw key is last 32 bytes
    const rawPublicKey = spkiDer.slice(-32);

    // Build OpenSSH format: "ssh-ed25519" + key data
    // OpenSSH format: 4-byte length + "ssh-ed25519" + 4-byte length + 32-byte key
    const keyType = "ssh-ed25519";
    const keyTypeLength = Buffer.alloc(4);
    keyTypeLength.writeUInt32BE(keyType.length);

    const keyDataLength = Buffer.alloc(4);
    keyDataLength.writeUInt32BE(rawPublicKey.length);

    const blob = Buffer.concat([keyTypeLength, Buffer.from(keyType), keyDataLength, rawPublicKey]);

    return `ssh-ed25519 ${blob.toString("base64")}`;
  }

  /**
   * Detect GitHub username via `gh auth status`.
   * Result is cached after first call.
   */
  private async detectGitHubUser(): Promise<GitHubStatus> {
    // Return cached result
    if (this.githubStatusCache) return this.githubStatusCache;

    // Dedupe concurrent calls
    if (this.githubStatusPromise) return this.githubStatusPromise;

    this.githubStatusPromise = this.doDetectGitHubUser();
    this.githubStatusCache = await this.githubStatusPromise;
    this.githubStatusPromise = null;

    return this.githubStatusCache;
  }

  private async doDetectGitHubUser(): Promise<GitHubStatus> {
    try {
      // Try to get GitHub username from gh CLI
      using proc = execAsync("gh auth status 2>&1");
      const { stdout } = await proc.result;

      // Parse output for username
      // Format: "✓ Logged in to github.com account username (keyring)"
      // or: "account username"
      const accountMatch = /account\s+(\S+)/i.exec(stdout);
      if (accountMatch) {
        const username = accountMatch[1];
        log.info("[SigningService] Detected GitHub user:", username);
        return { username, error: null };
      }

      // Check if logged in but couldn't parse username
      if (stdout.includes("Logged in")) {
        log.warn("[SigningService] gh auth status indicates logged in but couldn't parse username");
        return { username: null, error: "Could not parse GitHub username from gh auth status" };
      }

      // Not logged in
      log.info("[SigningService] gh CLI not authenticated");
      return {
        username: null,
        error: "Not logged in to GitHub CLI. Run `gh auth login` to authenticate.",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check for common error cases
      if (
        message.includes("command not found") ||
        message.includes("not recognized") ||
        message.includes("ENOENT")
      ) {
        log.info("[SigningService] gh CLI not installed");
        return {
          username: null,
          error: "GitHub CLI (gh) not installed. Install from https://cli.github.com",
        };
      }

      if (message.includes("not logged in") || message.includes("auth login")) {
        log.info("[SigningService] gh CLI not authenticated");
        return {
          username: null,
          error: "Not logged in to GitHub CLI. Run `gh auth login` to authenticate.",
        };
      }

      log.warn("[SigningService] gh auth status failed:", message);
      return { username: null, error: `GitHub CLI error: ${message}` };
    }
  }

  /**
   * Get signing capabilities - whether signing is available and GitHub user status.
   */
  async getCapabilities(): Promise<SigningCapabilities> {
    const keyPair = this.loadKeyPair();

    if (!keyPair) {
      return {
        available: false,
        publicKey: null,
        githubUser: null,
        githubError: this.keyLoadError,
      };
    }

    const githubStatus = await this.detectGitHubUser();

    return {
      available: true,
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: githubStatus.username,
      githubError: githubStatus.error,
    };
  }

  /**
   * Sign content and return signature with metadata.
   *
   * @param content - The content to sign (will be UTF-8 encoded)
   * @returns Signature and public key
   * @throws Error if no Ed25519 key is available
   */
  async sign(content: string): Promise<SignResult> {
    const keyPair = this.loadKeyPair();
    if (!keyPair) {
      throw new Error(this.keyLoadError ?? "No Ed25519 key available for signing");
    }

    const githubStatus = await this.detectGitHubUser();

    // Sign the content using Ed25519
    // Node's crypto.sign with Ed25519 doesn't need to specify an algorithm
    const contentBytes = Buffer.from(content, "utf-8");

    // Use the raw private key with tweetnacl-style signing
    // Node's sign() expects the full private key, not raw bytes
    // We need to re-import the raw key for signing
    const signature = sign(null, contentBytes, {
      key: Buffer.concat([
        // PKCS8 header for Ed25519 private key
        Buffer.from("302e020100300506032b657004220420", "hex"),
        keyPair.privateKey,
      ]),
      format: "der",
      type: "pkcs8",
    });

    return {
      signature: signature.toString("base64"),
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: githubStatus.username,
    };
  }

  /**
   * Clear cached GitHub status (useful for re-checking after user logs in).
   */
  clearGitHubCache(): void {
    this.githubStatusCache = null;
    log.info("[SigningService] Cleared GitHub status cache");
  }
}

// Singleton instance
let signingService: SigningService | null = null;

export function getSigningService(): SigningService {
  signingService ??= new SigningService();
  return signingService;
}
