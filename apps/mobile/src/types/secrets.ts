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
