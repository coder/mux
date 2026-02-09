import { useEffect, useState } from "react";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { VERSION } from "@/version";
import type { UpdateStatus } from "@/common/orpc/types";
import MuxLogoDark from "@/browser/assets/logos/mux-logo-dark.svg?react";
import MuxLogoLight from "@/browser/assets/logos/mux-logo-light.svg?react";
import { useTheme } from "@/browser/contexts/ThemeContext";
import { useAPI } from "@/browser/contexts/API";
import { useAboutDialog } from "@/browser/contexts/AboutDialogContext";
import { Button } from "@/browser/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/browser/components/ui/dialog";

interface VersionRecord {
  buildTime?: unknown;
  git?: unknown;
  git_describe?: unknown;
}

function formatExtendedTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

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

function parseVersionInfo(version: unknown): { gitDescribe: string; buildTime: string } {
  if (typeof version !== "object" || version === null) {
    return {
      gitDescribe: "dev",
      buildTime: "Unknown build time",
    };
  }

  const versionRecord = version as VersionRecord;
  const gitDescribe =
    typeof versionRecord.git_describe === "string"
      ? versionRecord.git_describe
      : typeof versionRecord.git === "string"
        ? versionRecord.git
        : "dev";

  return {
    gitDescribe,
    buildTime:
      typeof versionRecord.buildTime === "string"
        ? formatExtendedTimestamp(versionRecord.buildTime)
        : "Unknown build time",
  };
}

export function AboutDialog() {
  const { isOpen, close } = useAboutDialog();
  const { api } = useAPI();
  const { theme } = useTheme();
  const MuxLogo = theme === "dark" || theme.endsWith("-dark") ? MuxLogoDark : MuxLogoLight;
  const { gitDescribe, buildTime } = parseVersionInfo(VERSION satisfies unknown);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ type: "idle" });

  const isDesktop = typeof window !== "undefined" && Boolean(window.api);

  useEffect(() => {
    if (!isOpen || !isDesktop || !api) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.update.onStatus(undefined, { signal });
        for await (const status of iterator) {
          if (signal.aborted) {
            break;
          }
          setUpdateStatus(status);
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("Update status stream error:", error);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [api, isDesktop, isOpen]);

  const isChecking = updateStatus.type === "checking" || updateStatus.type === "downloading";

  const handleCheckForUpdates = () => {
    api?.update.check(undefined).catch(console.error);
  };

  const handleDownload = () => {
    api?.update.download(undefined).catch(console.error);
  };

  const handleInstall = () => {
    api?.update.install(undefined).catch(console.error);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent maxWidth="520px" aria-describedby={undefined} className="space-y-4">
        <DialogTitle>About Mux</DialogTitle>

        <div className="border-border-medium bg-modal-bg flex items-center gap-3 rounded-md border p-3">
          <MuxLogo className="h-7 w-7" />
          <div>
            <div className="text-foreground text-sm font-semibold">Mux</div>
            <div className="text-muted text-xs">Parallel agent workflows</div>
          </div>
        </div>

        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted">Version</span>
            <span className="text-foreground font-mono">{gitDescribe}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted">Built</span>
            <span className="text-foreground text-right text-xs">{buildTime}</span>
          </div>
        </div>

        <div className="border-border-medium space-y-3 border-t pt-3">
          <div className="text-foreground text-sm font-medium">Updates</div>

          {!isDesktop ? (
            <div className="text-muted text-xs">
              Desktop updates are available in the Electron app only.
            </div>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={isChecking}
                onClick={handleCheckForUpdates}
              >
                {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Check for Updates
              </Button>

              {updateStatus.type === "checking" && (
                <div className="text-muted text-xs">Checking for updates…</div>
              )}

              {updateStatus.type === "available" && (
                <div className="flex items-center justify-between gap-3">
                  <div className="text-foreground text-xs">
                    Update available: <span className="font-mono">{updateStatus.info.version}</span>
                  </div>
                  <Button size="sm" onClick={handleDownload}>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </Button>
                </div>
              )}

              {updateStatus.type === "downloading" && (
                <div className="text-muted text-xs">
                  Downloading update: {updateStatus.percent}%
                </div>
              )}

              {updateStatus.type === "downloaded" && (
                <div className="flex items-center justify-between gap-3">
                  <div className="text-foreground text-xs">
                    Ready to install: <span className="font-mono">{updateStatus.info.version}</span>
                  </div>
                  <Button size="sm" onClick={handleInstall}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Install & restart
                  </Button>
                </div>
              )}

              {updateStatus.type === "up-to-date" && (
                <div className="text-muted text-xs">Mux is up to date.</div>
              )}

              {updateStatus.type === "idle" && (
                <div className="text-muted text-xs">Run a manual check to look for updates.</div>
              )}

              {updateStatus.type === "error" && (
                <div className="space-y-2">
                  <div className="text-destructive text-xs">
                    Update check failed: {updateStatus.message}
                  </div>
                  <Button variant="outline" size="sm" onClick={handleCheckForUpdates}>
                    Try again
                  </Button>
                </div>
              )}
            </>
          )}

          <a
            href="https://github.com/coder/mux/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent inline-block text-xs hover:underline"
          >
            View all releases
          </a>
        </div>
      </DialogContent>
    </Dialog>
  );
}
