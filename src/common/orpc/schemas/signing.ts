/**
 * Signing ORPC schemas
 *
 * Defines input/output schemas for Ed25519 message signing endpoints.
 * Used for signing mux.md shared content with optional GitHub identity.
 */

import { z } from "zod";

// --- Capabilities endpoint ---

export const signingCapabilitiesInput = z.object({});

export const signingErrorOutput = z.object({
  /** Error message */
  message: z.string(),
  /** True if a compatible key was found but requires a passphrase */
  hasEncryptedKey: z.boolean(),
});

export const signingCapabilitiesOutput = z.object({
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...), null if no Ed25519 key found */
  publicKey: z.string().nullable(),
  /** Detected GitHub username, if any */
  githubUser: z.string().nullable(),
  /** Error info if key loading or identity detection failed */
  error: signingErrorOutput.nullable(),
});

export type SigningCapabilities = z.infer<typeof signingCapabilitiesOutput>;

// --- Get sign credentials endpoint ---
// Returns credentials needed for native signing via mux-md-client

export const getSignCredentialsInput = z.object({});

export const getSignCredentialsOutput = z.object({
  /** Base64-encoded private key bytes (32 bytes for Ed25519, variable for ECDSA) */
  privateKeyBase64: z.string(),
  /** Public key in OpenSSH format */
  publicKey: z.string(),
  /** Detected GitHub username, if any */
  githubUser: z.string().nullable(),
});

export type SignCredentials = z.infer<typeof getSignCredentialsOutput>;

// --- Clear identity cache endpoint ---

export const clearIdentityCacheInput = z.object({});
export const clearIdentityCacheOutput = z.object({
  success: z.boolean(),
});

// Grouped schemas for router
export const signing = {
  capabilities: {
    input: signingCapabilitiesInput,
    output: signingCapabilitiesOutput,
  },
  getSignCredentials: {
    input: getSignCredentialsInput,
    output: getSignCredentialsOutput,
  },
  clearIdentityCache: {
    input: clearIdentityCacheInput,
    output: clearIdentityCacheOutput,
  },
};
