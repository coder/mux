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
}

export type ProvidersConfigMap = Record<string, ProviderConfigDisplay>;
