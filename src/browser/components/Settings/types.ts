import type { ReactNode } from "react";

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  component: React.ComponentType;
}

export interface ProviderConfigDisplay {
  apiKeySet: boolean;
  baseUrl?: string;
  models?: string[];
  // Bedrock-specific fields
  region?: string;
  bearerTokenSet?: boolean;
  accessKeyIdSet?: boolean;
  secretAccessKeySet?: boolean;
  // Mux Gateway-specific fields
  voucherSet?: boolean;
  // Allow additional fields for extensibility
  [key: string]: unknown;
}

export type ProvidersConfigMap = Record<string, ProviderConfigDisplay>;
