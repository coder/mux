/**
 * Signing Service
 *
 * Provides Ed25519 message signing for mux.md.
 * - Loads Ed25519 key from ~/.mux/id_ed25519 or ~/.ssh/id_ed25519 using sshpk
 * - Signs content with private key
 * - Returns public key in OpenSSH format
 * - Detects GitHub username via `gh auth status`
 * - Falls back to git commit email for identity
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import sshpk from "sshpk";
import { execAsync } from "@/node/utils/disposableExec";
import { log } from "@/node/services/log";

interface KeyPair {
  privateKey: sshpk.PrivateKey;
  publicKeyOpenSSH: string;
}

interface IdentityStatus {
  githubUser: string | null;
  email: string | null;
  error: string | null;
}

interface SigningCapabilities {
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...), null if unavailable */
  publicKey: string | null;
  /** Detected GitHub username, if any */
  githubUser: string | null;
  /** Git commit email as fallback identity */
  email: string | null;
  /** Error message if key loading or identity detection failed */
  error: string | null;
}

interface SignResult {
  /** Base64-encoded Ed25519 signature (64 bytes) */
  signature: string;
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

        this.keyPair = { privateKey, publicKeyOpenSSH };

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
   * Detect identity: GitHub username via `gh auth status`, fallback to git email.
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
    let email: string | null = null;
    let error: string | null = null;

    // Try GitHub CLI first
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
        error = "Not logged in to GitHub CLI";
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("command not found") || message.includes("ENOENT")) {
        log.info("[SigningService] gh CLI not installed");
      } else {
        log.info("[SigningService] gh auth status failed:", message);
      }
    }

    // Try git email as fallback identity
    try {
      using proc = execAsync("git config user.email");
      const { stdout } = await proc.result;
      const trimmed = stdout.trim();
      if (trimmed) {
        email = trimmed;
        log.info("[SigningService] Detected git email:", email);
      }
    } catch {
      log.info("[SigningService] Could not get git user.email");
    }

    // Only report error if we have neither GitHub nor email
    if (!githubUser && !email && !error) {
      error = "No identity found. Set up GitHub CLI or configure git user.email";
    } else if (!githubUser && email) {
      // Clear error if we have email fallback
      error = null;
    }

    return { githubUser, email, error };
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
        email: null,
        error: this.keyLoadError,
      };
    }

    const identity = await this.detectIdentity();

    return {
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: identity.githubUser,
      email: identity.email,
      error: identity.error,
    };
  }

  /**
   * Sign content and return signature with metadata.
   *
   * @param content - The content to sign (will be UTF-8 encoded)
   * @returns Signature and public key
   * @throws Error if no signing key is available
   */
  async sign(content: string): Promise<SignResult> {
    const keyPair = this.loadKeyPair();
    if (!keyPair) {
      throw new Error(this.keyLoadError ?? "No signing key available");
    }

    const identity = await this.detectIdentity();

    // Choose hash algorithm based on key type
    // Ed25519 uses sha512, ECDSA uses sha256 (standard for P-256)
    const hashAlgo = keyPair.privateKey.type === "ed25519" ? "sha512" : "sha256";

    // Sign using sshpk's createSign
    const signer = keyPair.privateKey.createSign(hashAlgo);
    signer.update(content);
    const signature = signer.sign();

    // Get signature bytes - use "asn1" format for ECDSA (DER encoded), "raw" for Ed25519
    const format = keyPair.privateKey.type === "ed25519" ? "raw" : "asn1";
    const signatureBuffer = signature.toBuffer(format);

    return {
      signature: signatureBuffer.toString("base64"),
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
