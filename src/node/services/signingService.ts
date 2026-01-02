/**
 * Signing Service
 *
 * Provides signing credentials for mux.md shares.
 * - Loads keys from ~/.mux/message_signing_key or ~/.ssh/id_* using sshpk
 * - Returns private key bytes for use with mux-md-client native signing
 * - Returns public key in OpenSSH format
 * - Detects GitHub username via `gh auth status`
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import sshpk from "sshpk";
import { execAsync } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";

interface KeyPair {
  privateKey: sshpk.PrivateKey;
  privateKeyBytes: Uint8Array;
  publicKeyOpenSSH: string;
}

interface IdentityStatus {
  githubUser: string | null;
  error: string | null;
}

interface SigningCapabilities {
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...), null if unavailable */
  publicKey: string | null;
  /** Detected GitHub username, if any */
  githubUser: string | null;
  /** Error message if key loading or identity detection failed */
  error: string | null;
}

interface SignCredentials {
  /** Base64-encoded private key bytes for use with mux-md-client */
  privateKeyBase64: string;
  /** Public key in OpenSSH format */
  publicKey: string;
  /** Detected GitHub username, if any */
  githubUser: string | null;
}

/** Supported key types for signing */
const SUPPORTED_KEY_TYPES = ["ed25519", "ecdsa"];

/** Default paths to check for signing keys, in order of preference */
export function getDefaultKeyPaths(): string[] {
  return [
    join(homedir(), ".mux", "message_signing_key"), // Explicit mux key (any supported type, symlink-friendly)
    join(homedir(), ".ssh", "id_ed25519"), // SSH Ed25519
    join(homedir(), ".ssh", "id_ecdsa"), // SSH ECDSA
  ];
}

/**
 * Service for message signing (Ed25519 or ECDSA).
 * Loads key from ~/.mux/message_signing_key or ~/.ssh/id_ed25519 or ~/.ssh/id_ecdsa.
 */
export class SigningService {
  private keyPair: KeyPair | null = null;
  private keyLoadAttempted = false;
  private keyLoadError: string | null = null;
  private identityCache: IdentityStatus | null = null;
  private identityPromise: Promise<IdentityStatus> | null = null;
  private readonly keyPaths: string[];

  constructor(keyPaths?: string[]) {
    this.keyPaths = keyPaths ?? getDefaultKeyPaths();
  }

  /**
   * Load a signing keypair from disk using sshpk.
   * Tries ~/.mux/message_signing_key first, then SSH keys.
   * Supports Ed25519 and ECDSA keys in PEM or OpenSSH format.
   * Returns null if no supported key is found.
   */
  private loadKeyPair(): KeyPair | null {
    if (this.keyLoadAttempted) return this.keyPair;
    this.keyLoadAttempted = true;

    for (const keyPath of this.keyPaths) {
      if (!existsSync(keyPath)) continue;

      try {
        log.info("[SigningService] Attempting to load key from:", keyPath);
        const keyData = readFileSync(keyPath, "utf-8");

        // Parse with sshpk (auto-detects format)
        const privateKey = sshpk.parsePrivateKey(keyData, "auto", { filename: keyPath });

        // Verify it's a supported key type
        if (!SUPPORTED_KEY_TYPES.includes(privateKey.type)) {
          log.info(
            "[SigningService] Key at",
            keyPath,
            "is",
            privateKey.type,
            "- not supported (need ed25519 or ecdsa), skipping"
          );
          continue;
        }

        // Get public key in OpenSSH format
        const publicKeyOpenSSH = privateKey.toPublic().toString("ssh");

        // Extract raw private key bytes for use with mux-md-client signing
        const privateKeyBytes = this.extractPrivateKeyBytes(privateKey);

        this.keyPair = { privateKey, privateKeyBytes, publicKeyOpenSSH };

        log.info("[SigningService] Loaded", privateKey.type, "key from:", keyPath);
        log.info("[SigningService] Public key:", publicKeyOpenSSH.slice(0, 50) + "...");
        return this.keyPair;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Check for encrypted key
        if (message.includes("encrypted") || message.includes("passphrase")) {
          log.info(
            "[SigningService] Encrypted key at",
            keyPath,
            "- skipping (passphrase required)"
          );
          continue;
        }
        log.warn("[SigningService] Failed to load key from", keyPath + ":", message);
      }
    }

    this.keyLoadError = `No signing key found. Create ~/.mux/message_signing_key or ensure ~/.ssh/id_ed25519 or ~/.ssh/id_ecdsa exists.`;
    log.info("[SigningService]", this.keyLoadError);
    return null;
  }

  /**
   * Extract raw private key bytes from sshpk key for use with mux-md-client.
   */
  private extractPrivateKeyBytes(privateKey: sshpk.PrivateKey): Uint8Array {
    // sshpk stores keys with a 'part' object lookup by key component name
    // For Ed25519: part.k contains the 32-byte seed (private key)
    // For ECDSA: part.d contains the private scalar
    // The types are incomplete, so we use type assertions
    const parts = privateKey.part as unknown as Record<string, { data: Buffer }>;
    if (privateKey.type === "ed25519") {
      const kPart = parts.k;
      if (!kPart) throw new Error("Ed25519 key missing 'k' component");
      return new Uint8Array(kPart.data);
    } else if (privateKey.type === "ecdsa") {
      const dPart = parts.d;
      if (!dPart) throw new Error("ECDSA key missing 'd' component");
      // sshpk may pad with leading zero byte for ASN.1 encoding; strip it
      let data = dPart.data;
      if (data[0] === 0 && data.length > 32) {
        data = data.subarray(1);
      }
      return new Uint8Array(data);
    }
    throw new Error(`Unsupported key type: ${privateKey.type}`);
  }

  /**
   * Detect identity: GitHub username via `gh auth status`.
   * Result is cached after first call.
   */
  private async detectIdentity(): Promise<IdentityStatus> {
    if (this.identityCache) return this.identityCache;
    if (this.identityPromise) return this.identityPromise;

    this.identityPromise = this.doDetectIdentity();
    this.identityCache = await this.identityPromise;
    this.identityPromise = null;

    return this.identityCache;
  }

  private async doDetectIdentity(): Promise<IdentityStatus> {
    let githubUser: string | null = null;
    let error: string | null = null;

    // Detect GitHub username via CLI
    try {
      using proc = execAsync("gh auth status 2>&1");
      const { stdout } = await proc.result;

      const accountMatch = /account\s+(\S+)/i.exec(stdout);
      if (accountMatch) {
        githubUser = accountMatch[1];
        log.info("[SigningService] Detected GitHub user:", githubUser);
      } else if (stdout.includes("Logged in")) {
        log.warn("[SigningService] gh auth status indicates logged in but couldn't parse username");
        error = "Could not parse GitHub username from gh auth status";
      } else {
        error = "Not logged in to GitHub CLI (run: gh auth login)";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("command not found") || message.includes("ENOENT")) {
        log.info("[SigningService] gh CLI not installed");
        error = "GitHub CLI not installed (brew install gh)";
      } else {
        log.info("[SigningService] gh auth status failed:", message);
        error = "GitHub CLI error";
      }
    }

    return { githubUser, error };
  }

  /**
   * Get signing capabilities - public key and identity info.
   */
  async getCapabilities(): Promise<SigningCapabilities> {
    const keyPair = this.loadKeyPair();

    if (!keyPair) {
      return {
        publicKey: null,
        githubUser: null,
        error: this.keyLoadError,
      };
    }

    const identity = await this.detectIdentity();

    return {
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: identity.githubUser,
      error: identity.error,
    };
  }

  /**
   * Get signing credentials for use with mux-md-client native signing.
   * Returns private key bytes (base64), public key, and identity info.
   *
   * @returns Credentials for native signing
   * @throws Error if no signing key is available
   */
  async getSignCredentials(): Promise<SignCredentials> {
    const keyPair = this.loadKeyPair();
    if (!keyPair) {
      throw new Error(this.keyLoadError ?? "No signing key available");
    }

    const identity = await this.detectIdentity();

    // Base64 encode the private key bytes for transport over IPC
    const privateKeyBase64 = Buffer.from(keyPair.privateKeyBytes).toString("base64");

    return {
      privateKeyBase64,
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: identity.githubUser,
    };
  }

  /**
   * Clear all cached state including key and identity.
   * Allows re-detection after user creates a key or logs in.
   */
  clearIdentityCache(): void {
    this.keyPair = null;
    this.keyLoadAttempted = false;
    this.keyLoadError = null;
    this.identityCache = null;
    this.identityPromise = null;
    log.info("[SigningService] Cleared key and identity cache");
  }
}

// Singleton instance
let signingService: SigningService | null = null;

export function getSigningService(): SigningService {
  signingService ??= new SigningService();
  return signingService;
}
