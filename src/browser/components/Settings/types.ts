import type { ReactNode } from "react";

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  component: React.ComponentType;
}

/** AWS credential status for Bedrock provider */
export interface AWSCredentialStatus {
  region?: string;
  bearerTokenSet: boolean;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
}

export interface ProviderConfigDisplay {
  apiKeySet: boolean;
  baseUrl?: string;
  models?: string[];
  /** AWS-specific fields (only present for bedrock provider) */
  aws?: AWSCredentialStatus;
}

export type ProvidersConfigMap = Record<string, ProviderConfigDisplay>;
