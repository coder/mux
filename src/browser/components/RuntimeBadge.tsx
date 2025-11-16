import React from "react";
import { cn } from "@/common/lib/utils";
import type { RuntimeConfig } from "@/common/types/runtime";
import { isSSHRuntime } from "@/common/types/runtime";
import { extractSshHostname } from "@/browser/utils/ui/runtimeBadge";
import { TooltipWrapper, Tooltip } from "./Tooltip";

interface RuntimeBadgeProps {
  runtimeConfig?: RuntimeConfig;
  className?: string;
}

/**
 * Badge to display SSH runtime information.
 * Shows icon-only badge for SSH runtimes with hostname in tooltip.
 */
export function RuntimeBadge({ runtimeConfig, className }: RuntimeBadgeProps) {
  const hostname = extractSshHostname(runtimeConfig);

  if (!hostname) {
    return null;
  }

  return (
    <TooltipWrapper inline>
      <span
        className={cn(
          "inline-flex items-center rounded px-1 py-0.5",
          "bg-accent/10 text-accent border border-accent/30",
          className
        )}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="SSH Runtime"
        >
          {/* Server rack icon */}
          <rect x="2" y="2" width="12" height="4" rx="1" />
          <rect x="2" y="10" width="12" height="4" rx="1" />
          <line x1="5" y1="4" x2="5" y2="4" />
          <line x1="5" y1="12" x2="5" y2="12" />
        </svg>
      </span>
      <Tooltip align="right">
        SSH: {isSSHRuntime(runtimeConfig) ? runtimeConfig.host : hostname}
      </Tooltip>
    </TooltipWrapper>
  );
}
