import { z } from "zod";

export const HostKeyVerificationRequestSchema = z.object({
  requestId: z.string(),
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  prompt: z.string(),
});

export type HostKeyVerificationRequest = z.infer<typeof HostKeyVerificationRequestSchema>;
