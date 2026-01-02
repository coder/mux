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
  private identityCache: IdentityStatus | null = null;
  private identityPromise: Promise<IdentityStatus> | null = null;

  /**
   * Load the Ed25519 keypair from disk using sshpk.
   * Tries ~/.mux/id_ed25519 first, then ~/.ssh/id_ed25519.
   * Supports PEM and OpenSSH private key formats.
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

        // Parse with sshpk (auto-detects format)
        const privateKey = sshpk.parsePrivateKey(keyData, "auto", { filename: keyPath });

        // Verify it's Ed25519
        if (privateKey.type !== "ed25519") {
          log.info(
            "[SigningService] Key at",
            keyPath,
            "is",
            privateKey.type,
            "not ed25519, skipping"
          );
          continue;
        }

        // Get public key in OpenSSH format
        const publicKeyOpenSSH = privateKey.toPublic().toString("ssh");

        this.keyPair = { privateKey, publicKeyOpenSSH };

        log.info("[SigningService] Loaded Ed25519 key from:", keyPath);
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

    this.keyLoadError = `No Ed25519 key found. Checked: ${KEY_PATHS.join(", ")}`;
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
   * @throws Error if no Ed25519 key is available
   */
  async sign(content: string): Promise<SignResult> {
    const keyPair = this.loadKeyPair();
    if (!keyPair) {
      throw new Error(this.keyLoadError ?? "No Ed25519 key available for signing");
    }

    const identity = await this.detectIdentity();

    // Sign using sshpk's createSign
    const signer = keyPair.privateKey.createSign("sha512");
    signer.update(content);
    const signature = signer.sign();

    // Get raw signature bytes (sshpk returns in SSH format, we want raw)
    const signatureBuffer = signature.toBuffer("raw");

    return {
      signature: signatureBuffer.toString("base64"),
      publicKey: keyPair.publicKeyOpenSSH,
      githubUser: identity.githubUser,
    };
  }

  /**
   * Clear cached identity (useful for re-checking after user logs in).
   */
  clearIdentityCache(): void {
    this.identityCache = null;
    log.info("[SigningService] Cleared identity cache");
  }
}

// Singleton instance
let signingService: SigningService | null = null;

export function getSigningService(): SigningService {
  signingService ??= new SigningService();
  return signingService;
}
