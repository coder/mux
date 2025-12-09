import type { ReactNode } from "react";
import type {
  AWSCredentialStatus,
  ProviderConfigInfo,
  ProvidersConfigMap,
} from "@/common/orpc/types";

// Re-export types for local usage
export type { AWSCredentialStatus, ProvidersConfigMap };

// Alias for backward compatibility (ProviderConfigDisplay was the old name)
export type ProviderConfigDisplay = ProviderConfigInfo;

export interface SettingsSection {
  id: string;
  label: string;
  icon: ReactNode;
  component: React.ComponentType;
}
