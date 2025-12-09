import type z from "zod";
import type { SecretSchema } from "../orpc/schemas";

export type Secret = z.infer<typeof SecretSchema>;

/**
 * SecretsConfig - Maps project paths to their secrets
 * Format: { [projectPath: string]: Secret[] }
 */
export type SecretsConfig = Record<string, Secret[]>;

/**
 * Convert an array of secrets to a Record for environment variable injection
 * @param secrets Array of Secret objects
 * @returns Record mapping secret keys to values
 */
export function secretsToRecord(secrets: Secret[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const secret of secrets) {
    record[secret.key] = secret.value;
  }
  return record;
}
