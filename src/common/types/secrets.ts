/**
 * Secret - A key-value pair for storing sensitive configuration
 */
export interface Secret {
  key: string;
  value: string;
}

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
