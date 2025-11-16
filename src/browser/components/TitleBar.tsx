import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/common/lib/utils";
import { VERSION } from "@/version";
import { ThemeToggleButton } from "./ThemeToggleButton";
import { TooltipWrapper, Tooltip } from "./Tooltip";
import type { UpdateStatus } from "@/common/types/ipc";
import { isTelemetryEnabled } from "@/common/telemetry";

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

function formatUSDate(isoDate: string): string {
  const date = new Date(isoDate);
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
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
      buildDate: formatUSDate(buildTime),
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
  const { buildDate, extendedTimestamp, gitDescribe } = parseBuildInfo(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });
  const [isCheckingOnHover, setIsCheckingOnHover] = useState(false);
  const lastHoverCheckTime = useRef<number>(0);
  const telemetryEnabled = isTelemetryEnabled();

  useEffect(() => {
    // Skip update checks if telemetry is disabled
    if (!telemetryEnabled) {
      return;
    }

    // Skip update checks in browser mode - app updates only apply to Electron
    if (window.api.platform === "browser") {
      return;
    }

    // Subscribe to update status changes (will receive current status immediately)
    const unsubscribe = window.api.update.onStatus((status) => {
      setUpdateStatus(status);
      setIsCheckingOnHover(false); // Clear checking state when status updates
    });

    // Check for updates on mount
    window.api.update.check().catch(console.error);

    // Check periodically
    const checkInterval = setInterval(() => {
      window.api.update.check().catch(console.error);
    }, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      unsubscribe();
      clearInterval(checkInterval);
    };
  }, [telemetryEnabled]);

  const handleIndicatorHover = () => {
    if (!telemetryEnabled) return;

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
      window.api.update.check().catch((error) => {
        console.error("Update check failed:", error);
        setIsCheckingOnHover(false);
      });
    }
  };

  const handleUpdateClick = () => {
    if (!telemetryEnabled) return; // No-op if telemetry disabled

    if (updateStatus.type === "available") {
      window.api.update.download().catch(console.error);
    } else if (updateStatus.type === "downloaded") {
      window.api.update.install();
    }
  };

  const getUpdateTooltip = () => {
    const currentVersion = gitDescribe ?? "dev";
    const lines: React.ReactNode[] = [`Current: ${currentVersion}`];

    if (!telemetryEnabled) {
      lines.push(
        "Update checks disabled (telemetry is off)",
        "Enable telemetry to receive updates."
      );
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

  const getIndicatorStatus = (): "available" | "downloading" | "downloaded" | "disabled" => {
    if (!telemetryEnabled) return "disabled";

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

  return (
    <div className="bg-dark border-border-light font-primary text-muted flex shrink-0 items-center justify-between border-b px-4 py-2 text-[11px] select-none">
      <div className="mr-4 flex min-w-0 items-center gap-2">
        {showUpdateIndicator && (
          <TooltipWrapper>
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
              <span className="text-sm">
                {indicatorStatus === "disabled"
                  ? "⊘"
                  : indicatorStatus === "downloading"
                    ? "⟳"
                    : "↓"}
              </span>
            </div>
            <Tooltip align="left" interactive={true}>
              {getUpdateTooltip()}
            </Tooltip>
          </TooltipWrapper>
        )}
        <div className="min-w-0 cursor-text truncate text-xs font-normal tracking-wider select-text">
          mux {gitDescribe ?? "(dev)"}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <ThemeToggleButton />
        <TooltipWrapper>
          <div className="cursor-default text-[11px] opacity-70">{buildDate}</div>
          <Tooltip align="right">Built at {extendedTimestamp}</Tooltip>
        </TooltipWrapper>
      </div>
    </div>
  );
}
