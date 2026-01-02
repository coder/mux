/**
 * Signing ORPC schemas
 *
 * Defines input/output schemas for Ed25519 message signing endpoints.
 * Used for signing mux.md shared content with optional GitHub identity.
 */

import { z } from "zod";

// --- Capabilities endpoint ---

export const signingCapabilitiesInput = z.object({});

export const signingCapabilitiesOutput = z.object({
  /** Public key in OpenSSH format (ssh-ed25519 AAAA...), null if no Ed25519 key found */
  publicKey: z.string().nullable(),
  /** Detected GitHub username, if any */
  githubUser: z.string().nullable(),
  /** Git commit email as fallback identity */
  email: z.string().nullable(),
  /** Error message if key loading or identity detection failed */
  error: z.string().nullable(),
});

export type SigningCapabilities = z.infer<typeof signingCapabilitiesOutput>;

// --- Sign content endpoint ---

export const signContentInput = z.object({
  /** The content to sign (markdown body, not including frontmatter) */
  content: z.string(),
});

export const signContentOutput = z.object({
  /** Base64-encoded Ed25519 signature (64 bytes) */
  signature: z.string(),
  /** Public key in OpenSSH format */
  publicKey: z.string(),
  /** Detected GitHub username, if any */
  githubUser: z.string().nullable(),
});

export type SignResult = z.infer<typeof signContentOutput>;

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
  sign: {
    input: signContentInput,
    output: signContentOutput,
  },
  clearIdentityCache: {
    input: clearIdentityCacheInput,
    output: clearIdentityCacheOutput,
  },
};
