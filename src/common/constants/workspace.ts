import type { RuntimeConfig } from "@/common/types/runtime";

/**
 * Default runtime configuration for local workspaces
 * Used when no runtime config is specified
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  type: "local",
  srcBaseDir: "~/.cmux/src",
} as const;
