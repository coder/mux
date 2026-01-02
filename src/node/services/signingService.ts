/**
 * Signing Service
 *
 * Provides Ed25519 message signing for mux.md.
 * - Generates and caches Ed25519 keypair on first use
 * - Signs content with private key
 * - Returns public key in OpenSSH format
 * - Detects GitHub username via `gh auth status`
 */

import { generateKeyPairSync, sign, type KeyObject } from "crypto";
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

/**
 * Service for Ed25519 message signing.
 * Keypair is generated once and cached for the lifetime of the app.
 */
export class SigningService {
  private keyPair: KeyPair | null = null;
  private githubStatusCache: GitHubStatus | null = null;
  private githubStatusPromise: Promise<GitHubStatus> | null = null;

  /**
   * Get or generate the Ed25519 keypair.
   * Keypair is cached for all subsequent calls.
   */
  private getKeyPair(): KeyPair {
    if (this.keyPair) return this.keyPair;

    log.info("[SigningService] Generating Ed25519 keypair");

    // Generate Ed25519 keypair using Node's crypto
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    // Export private key in raw format for signing
    const privateKeyBuffer = privateKey.export({ type: "pkcs8", format: "der" });
    // PKCS8 DER for Ed25519 has 16 bytes prefix, raw key is last 32 bytes
    const rawPrivateKey = Buffer.from(privateKeyBuffer.slice(-32));

    // Convert PEM to OpenSSH format
    const openSSHKey = this.pemToOpenSSH(publicKey);

    this.keyPair = {
      privateKey: rawPrivateKey,
      publicKeyOpenSSH: openSSHKey,
    };

    log.info("[SigningService] Keypair generated, public key:", openSSHKey.slice(0, 50) + "...");
    return this.keyPair;
  }

  /**
   * Convert a Node.js KeyObject to OpenSSH format.
   */
  private pemToOpenSSH(publicKey: KeyObject): string {
    // Export as raw bytes (32 bytes for Ed25519)
    const rawKey = publicKey.export({ type: "spki", format: "der" });
    // SPKI DER for Ed25519 has 12 bytes prefix, raw key is last 32 bytes
    const rawPublicKey = rawKey.slice(-32);

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
    try {
      const keyPair = this.getKeyPair();
      const githubStatus = await this.detectGitHubUser();

      return {
        available: true,
        publicKey: keyPair.publicKeyOpenSSH,
        githubUser: githubStatus.username,
        githubError: githubStatus.error,
      };
    } catch (err) {
      log.error("[SigningService] Failed to get capabilities:", err);
      return {
        available: false,
        publicKey: null,
        githubUser: null,
        githubError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Sign content and return signature with metadata.
   *
   * @param content - The content to sign (will be UTF-8 encoded)
   * @returns Signature and public key
   */
  async sign(content: string): Promise<SignResult> {
    const keyPair = this.getKeyPair();
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
