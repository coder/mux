import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { VERSION } from "@/version";
import { SettingsButton } from "./SettingsButton";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import type { UpdateStatus } from "@/common/orpc/types";
import { Download, Loader2, RefreshCw } from "lucide-react";

import { useTutorial } from "@/browser/contexts/TutorialContext";
import { useAPI } from "@/browser/contexts/API";
import { isDesktopMode, getTitlebarLeftInset } from "@/browser/hooks/useDesktopTitlebar";

// Update check intervals
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const UPDATE_CHECK_HOVER_COOLDOWN_MS = 60 * 1000; // 1 minute

const updateStatusColors: Record<"available" | "downloading" | "downloaded" | "disabled", string> =
  {
    available: "#4CAF50", // Green for available
    downloading: "#2196F3", // Blue for downloading
    downloaded: "#FF9800", // Orange for ready to install
    disabled: "#666666", // Gray for disabled
  };

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

function formatLocalDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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
      buildDate: formatLocalDate(buildTime),
      extendedTimestamp: formatExtendedTimestamp(buildTime),
      gitDescribe,
    };
  }

  return {
    buildDate: "unknown",
    extendedTimestamp: "Unknown build time",
    gitDescribe: undefined,
  };
}

export function TitleBar() {
  const { api } = useAPI();
  const { extendedTimestamp, gitDescribe } = parseBuildInfo(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [isCheckingOnHover, setIsCheckingOnHover] = useState(false);
  const lastHoverCheckTime = useRef<number>(0);

  const { startSequence } = useTutorial();

  // Start settings tutorial on first launch
  useEffect(() => {
    // Small delay to ensure UI is rendered before showing tutorial
    const timer = setTimeout(() => {
      startSequence("settings");
    }, 500);
    return () => clearTimeout(timer);
  }, [startSequence]);

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
    if (updateStatus.type === "available") {
      api?.update.download().catch(console.error);
    } else if (updateStatus.type === "downloaded") {
      void api?.update.install();
    }
  };

  const getUpdateTooltip = () => {
    const currentVersion = gitDescribe ?? "dev";
    const lines: React.ReactNode[] = [`Current: ${currentVersion}`];

    if (isCheckingOnHover || updateStatus.type === "checking") {
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

  const getIndicatorStatus = (): "available" | "downloading" | "downloaded" | "disabled" => {
    if (isCheckingOnHover || updateStatus.type === "checking") return "disabled";

    switch (updateStatus.type) {
      case "available":
        return "available";
      case "downloading":
        return "downloading";
      case "downloaded":
        return "downloaded";
      default:
        return "disabled";
    }
  };

  const indicatorStatus = getIndicatorStatus();
  // Always show indicator in packaged builds (or dev with DEBUG_UPDATER)
  // In dev without DEBUG_UPDATER, the backend won't initialize updater service
  const showUpdateIndicator = true;

  // In desktop mode, add left padding for macOS traffic lights
  const leftInset = getTitlebarLeftInset();
  const isDesktop = isDesktopMode();

  return (
    <div
      className={cn(
        "bg-sidebar border-border-light font-primary text-muted flex h-8 shrink-0 items-center justify-between border-b px-4 text-[11px] select-none",
        // In desktop mode, make header draggable for window movement
        isDesktop && "titlebar-drag"
      )}
      style={leftInset > 0 ? { paddingLeft: leftInset } : undefined}
    >
      <div className={cn("mr-4 flex min-w-0 items-center gap-2", isDesktop && "titlebar-no-drag")}>
        {showUpdateIndicator && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "w-4 h-4 flex items-center justify-center",
                  indicatorStatus === "disabled"
                    ? "cursor-default"
                    : "cursor-pointer hover:opacity-70"
                )}
                style={{ color: updateStatusColors[indicatorStatus] }}
                onClick={handleUpdateClick}
                onMouseEnter={handleIndicatorHover}
              >
                {indicatorStatus === "disabled" ? (
                  <span className="text-sm">⊘</span>
                ) : indicatorStatus === "downloading" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : indicatorStatus === "downloaded" ? (
                  <RefreshCw className="size-3.5" />
                ) : (
                  <Download className="size-3.5" />
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent align="start" className="pointer-events-auto">
              {getUpdateTooltip()}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="min-w-0 cursor-text truncate text-xs font-normal tracking-wider select-text">
              mux {gitDescribe ?? "(dev)"}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            Built at {extendedTimestamp}
          </TooltipContent>
        </Tooltip>
      </div>
      {isDesktop ? (
        <div className="titlebar-no-drag">
          <SettingsButton />
        </div>
      ) : (
        <SettingsButton />
      )}
    </div>
  );
}
