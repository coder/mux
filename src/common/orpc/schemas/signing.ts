/**
 * Signing ORPC schemas
 *
 * Defines input/output schemas for mux.md message signing endpoints.
 * Used for signing shared content with optional GitHub identity attribution.
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
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...), null if no key is available */
  publicKey: z.string().nullable(),
  /** Detected GitHub username, if any */
  githubUser: z.string().nullable(),
  /** Error info if key loading or identity detection failed */
  error: signingErrorOutput.nullable(),
});

export type SigningCapabilities = z.infer<typeof signingCapabilitiesOutput>;

// --- signMessage endpoint ---
// Returns a mux.md-compatible signature envelope for the provided content.

export const signatureEnvelopeOutput = z.object({
  sig: z.string(),
  publicKey: z.string(),
  githubUser: z.string().optional(),
});

export type SignatureEnvelope = z.infer<typeof signatureEnvelopeOutput>;

export const signMessageInput = z
  .object({
    content: z.string(),
  })
  .strict();

export const signMessageOutput = signatureEnvelopeOutput;

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
  signMessage: {
    input: signMessageInput,
    output: signMessageOutput,
  },
  clearIdentityCache: {
    input: clearIdentityCacheInput,
    output: clearIdentityCacheOutput,
  },
};
