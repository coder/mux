import React from "react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import {
  isSSHRuntime,
  isWorktreeRuntime,
  isLocalProjectRuntime,
  isDockerRuntime,
  isDevcontainerRuntime,
} from "@/common/types/runtime";
import { RUNTIME_BADGE_UI } from "@/browser/utils/runtimeUi";

interface RuntimeBadgeInlineProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
}

type RuntimeType = keyof typeof RUNTIME_BADGE_UI;

function getRuntimeType(runtimeConfig?: RuntimeConfig): RuntimeType | null {
  if (isSSHRuntime(runtimeConfig)) {
    return runtimeConfig.coder ? "coder" : "ssh";
  }
  if (isWorktreeRuntime(runtimeConfig)) return "worktree";
  if (isLocalProjectRuntime(runtimeConfig)) return "local";
  if (isDockerRuntime(runtimeConfig)) return "docker";
  if (isDevcontainerRuntime(runtimeConfig)) return "devcontainer";
  return null;
}

/**
 * Inline runtime badge for use in tooltips or other contexts where
 * a nested tooltip would be inappropriate. Shows icon only with idle styling.
 */
export function RuntimeBadgeInline({ runtimeConfig, className }: RuntimeBadgeInlineProps) {
  const type = getRuntimeType(runtimeConfig);
  if (!type) return null;

  const badgeUi = RUNTIME_BADGE_UI[type];
  const Icon = badgeUi.Icon;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1 py-0.5 border transition-colors shrink-0",
        badgeUi.badge.idleClass,
        className
      )}
    >
      <Icon />
    </span>
  );
}
