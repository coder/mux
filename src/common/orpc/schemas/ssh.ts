import { z } from "zod";

export const HostKeyVerificationRequestSchema = z.object({
  requestId: z.string(),
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  prompt: z.string(),
});

export type HostKeyVerificationRequest = z.infer<typeof HostKeyVerificationRequestSchema>;

export const HostKeyVerificationEventSchema = z.discriminatedUnion("type", [
  HostKeyVerificationRequestSchema.extend({ type: z.literal("request") }),
  z.object({ type: z.literal("removed"), requestId: z.string() }),
]);

export type HostKeyVerificationEvent = z.infer<typeof HostKeyVerificationEventSchema>;
