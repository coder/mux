import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { VERSION } from "@/version";
import { SettingsButton } from "./SettingsButton";
import { GatewayIcon } from "./icons/GatewayIcon";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import {
  formatMuxGatewayBalance,
  useMuxGatewayAccountStatus,
} from "@/browser/hooks/useMuxGatewayAccountStatus";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { UpdateStatus } from "@/common/orpc/types";
import { Download, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { usePolicy } from "@/browser/contexts/PolicyContext";
import {
  isDesktopMode,
  getTitlebarLeftInset,
  DESKTOP_TITLEBAR_HEIGHT_CLASS,
} from "@/browser/hooks/useDesktopTitlebar";

// Update check intervals
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const UPDATE_CHECK_HOVER_COOLDOWN_MS = 60 * 1000; // 1 minute

interface VersionMetadata {
  buildTime: string;
  git_describe?: unknown;
}

function hasBuildInfo(value: unknown): value is VersionMetadata {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.buildTime === "string";
}

function formatExtendedTimestamp(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

function parseBuildInfo(version: unknown) {
  if (hasBuildInfo(version)) {
    const { buildTime, git_describe } = version;
    const gitDescribe = typeof git_describe === "string" ? git_describe : undefined;

    return {
      extendedTimestamp: formatExtendedTimestamp(buildTime),
      gitDescribe,
    };
  }

  return {
    extendedTimestamp: "Unknown build time",
    gitDescribe: undefined,
  };
}

export function TitleBar() {
  const { api } = useAPI();
  const policyState = usePolicy();
  const policyEnforced = policyState.status.state === "enforced";

  const { config: providersConfig } = useProvidersConfig();
  const muxGatewayIsLoggedIn = providersConfig?.["mux-gateway"]?.couponCodeSet ?? false;
  const {
    data: muxGatewayAccountStatus,
    error: muxGatewayAccountError,
    isLoading: muxGatewayAccountLoading,
    refresh: refreshMuxGatewayAccountStatus,
  } = useMuxGatewayAccountStatus();
  const [muxGatewayPopoverOpen, setMuxGatewayPopoverOpen] = useState(false);

  const { extendedTimestamp, gitDescribe } = parseBuildInfo(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [isCheckingOnHover, setIsCheckingOnHover] = useState(false);
  const lastHoverCheckTime = useRef<number>(0);

  useEffect(() => {
    // Skip update checks in browser mode - app updates only apply to Electron
    if (!window.api) {
      return;
    }

    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.update.onStatus(undefined, { signal });
        for await (const status of iterator) {
          if (signal.aborted) break;
          setUpdateStatus(status);
          setIsCheckingOnHover(false); // Clear checking state when status updates
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Update status stream error:", error);
        }
      }
    })();

    // Check for updates on mount
    api.update.check(undefined).catch(console.error);

    // Check periodically
    const checkInterval = setInterval(() => {
      api.update.check(undefined).catch(console.error);
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      controller.abort();
      clearInterval(checkInterval);
    };
  }, [api]);

  const handleIndicatorHover = () => {
    // Skip update checks in browser mode - app updates only apply to Electron
    if (!window.api) {
      return;
    }

    // Debounce: Only check once per cooldown period on hover
    const now = Date.now();

    if (now - lastHoverCheckTime.current < UPDATE_CHECK_HOVER_COOLDOWN_MS) {
      return; // Too soon since last hover check
    }

    // Only trigger check if idle/up-to-date and not already checking
    if (
      (updateStatus.type === "idle" || updateStatus.type === "up-to-date") &&
      !isCheckingOnHover
    ) {
      lastHoverCheckTime.current = now;
      setIsCheckingOnHover(true);
      api?.update.check().catch((error) => {
        console.error("Update check failed:", error);
        setIsCheckingOnHover(false);
      });
    }
  };

  const handleUpdateClick = () => {
    // Skip in browser mode - app updates only apply to Electron
    if (!window.api) {
      return;
    }

    if (updateStatus.type === "available") {
      api?.update.download().catch(console.error);
    } else if (updateStatus.type === "downloaded") {
      void api?.update.install();
    }
  };

  const getUpdateTooltip = () => {
    const currentVersion = gitDescribe ?? "dev";
    const lines: React.ReactNode[] = [`Current: ${currentVersion}`, `Built: ${extendedTimestamp}`];

    if (!window.api) {
      lines.push("Desktop updates are available in the Electron app only.");
    } else if (isCheckingOnHover || updateStatus.type === "checking") {
      lines.push("Checking for updates...");
    } else {
      switch (updateStatus.type) {
        case "available":
          lines.push(`Update available: ${updateStatus.info.version}`, "Click to download.");
          break;
        case "downloading":
          lines.push(`Downloading update: ${updateStatus.percent}%`);
          break;
        case "downloaded":
          lines.push(`Update ready: ${updateStatus.info.version}`, "Click to install and restart.");
          break;
        case "idle":
          lines.push("Hover to check for updates");
          break;
        case "up-to-date":
          lines.push("Up to date");
          break;
        case "error":
          lines.push("Update check failed", updateStatus.message);
          break;
      }
    }

    // Always add releases link as defense-in-depth
    lines.push(
      <a href="https://github.com/coder/mux/releases" target="_blank" rel="noopener noreferrer">
        View all releases
      </a>
    );

    return (
      <>
        {lines.map((line, i) => (
          <React.Fragment key={i}>
            {i > 0 && <br />}
            {line}
          </React.Fragment>
        ))}
      </>
    );
  };

  const updateBadgeIcon = (() => {
    if (updateStatus.type === "available") {
      return <Download className="size-3.5" />;
    }

    if (updateStatus.type === "downloaded") {
      return <RefreshCw className="size-3.5" />;
    }

    if (
      updateStatus.type === "downloading" ||
      updateStatus.type === "checking" ||
      isCheckingOnHover
    ) {
      return <Loader2 className="size-3.5 animate-spin" />;
    }

    return null;
  })();

  const isUpdateActionable =
    updateStatus.type === "available" || updateStatus.type === "downloaded";

  // In desktop mode, add left padding for macOS traffic lights
  const leftInset = getTitlebarLeftInset();
  const isDesktop = isDesktopMode();

  return (
    <div
      className={cn(
        "bg-sidebar border-border-light font-primary text-muted flex shrink-0 items-center justify-between border-b px-4 text-[11px] select-none",
        isDesktop ? DESKTOP_TITLEBAR_HEIGHT_CLASS : "h-8",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag"
      )}
      style={leftInset > 0 ? { paddingLeft: leftInset } : undefined}
    >
      <div
        className={cn(
          "mr-4 flex min-w-0",
          leftInset > 0 ? "flex-col" : "items-center gap-2",
          isDesktop && "titlebar-no-drag"
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className={cn(
                "flex items-center gap-1.5",
                isUpdateActionable ? "cursor-pointer hover:opacity-70" : "cursor-default"
              )}
              onClick={handleUpdateClick}
              onMouseEnter={handleIndicatorHover}
            >
              <div
                className={cn(
                  "min-w-0 cursor-text truncate font-normal tracking-wider select-text",
                  leftInset > 0 ? "text-[10px]" : "text-xs"
                )}
              >
                {gitDescribe ?? "(dev)"}
              </div>
              {updateBadgeIcon && (
                <div className="text-accent flex h-3.5 w-3.5 items-center justify-center">
                  {updateBadgeIcon}
                </div>
              )}
            </div>
          </TooltipTrigger>
          <TooltipContent align="start" className="pointer-events-auto">
            {getUpdateTooltip()}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className={cn("flex items-center gap-1.5", isDesktop && "titlebar-no-drag")}>
        {muxGatewayIsLoggedIn && (
          <Popover
            open={muxGatewayPopoverOpen}
            onOpenChange={(open) => {
              setMuxGatewayPopoverOpen(open);
              if (open) {
                void refreshMuxGatewayAccountStatus();
              }
            }}
          >
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 h-5 w-5 border"
                aria-label="Show Mux Gateway balance"
              >
                <GatewayIcon className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-3">
              <div className="text-foreground text-sm font-medium">Mux Gateway</div>

              <div className="mt-2 space-y-1 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted">Balance</span>
                  <span className="text-foreground font-mono">
                    {formatMuxGatewayBalance(muxGatewayAccountStatus?.remaining_microdollars)}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <span className="text-muted">Concurrent requests per user</span>
                  <span className="text-foreground font-mono">
                    {muxGatewayAccountStatus?.ai_gateway_concurrent_requests_per_user ?? "—"}
                  </span>
                </div>
              </div>

              {muxGatewayAccountError && (
                <div className="text-destructive mt-2 text-xs">{muxGatewayAccountError}</div>
              )}

              <div className="mt-3 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void refreshMuxGatewayAccountStatus();
                  }}
                  disabled={muxGatewayAccountLoading}
                >
                  {muxGatewayAccountLoading ? "Refreshing..." : "Refresh"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {policyEnforced && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="img"
                aria-label="Settings controlled by policy"
                className="border-border-light text-muted-foreground hover:border-border-medium/80 hover:bg-toggle-bg/70 flex h-5 w-5 items-center justify-center rounded border"
              >
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              </div>
            </TooltipTrigger>
            <TooltipContent align="end">Your settings are controlled by a policy.</TooltipContent>
          </Tooltip>
        )}
        <SettingsButton />
      </div>
    </div>
  );
}
