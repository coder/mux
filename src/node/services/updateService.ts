import { log } from "@/node/services/log";
import type { UpdateStatus } from "@/common/orpc/types";
import { parseDebugUpdater } from "@/common/utils/env";

// Interface matching the implementation class in desktop/updater.ts
// We redefine it here to avoid importing the class directly which brings in electron-updater
interface DesktopUpdaterService {
  checkForUpdates(): void;
  downloadUpdate(): Promise<void>;
  installUpdate(): void;
  subscribe(callback: (status: UpdateStatus) => void): () => void;
  getStatus(): UpdateStatus;
}

export class UpdateService {
  private impl: DesktopUpdaterService | null = null;
  private currentStatus: UpdateStatus = { type: "idle" };
  private subscribers = new Set<(status: UpdateStatus) => void>();

  constructor() {
    this.initialize().catch((err) => {
      log.error("Failed to initialize UpdateService:", err);
    });
  }

  private async initialize() {
    // Check if running in Electron Main process
    if (process.versions.electron) {
      try {
        // Dynamic import to avoid loading electron-updater in CLI
        // eslint-disable-next-line no-restricted-syntax
        const { UpdaterService: DesktopUpdater } = await import("@/desktop/updater");
        this.impl = new DesktopUpdater();

        // Forward updates
        this.impl.subscribe((status: UpdateStatus) => {
          this.currentStatus = status;
          this.notifySubscribers();
        });

        // Sync initial status
        this.currentStatus = this.impl.getStatus();
      } catch (err) {
        log.debug(
          "UpdateService: Failed to load desktop updater (likely CLI mode or missing dep):",
          err
        );
      }
    }
  }

  async check(): Promise<void> {
    if (this.impl) {
      if (process.versions.electron) {
        try {
          // eslint-disable-next-line no-restricted-syntax
          const { app } = await import("electron");

          const debugConfig = parseDebugUpdater(process.env.DEBUG_UPDATER);
          if (!app.isPackaged && !debugConfig.enabled) {
            log.debug("UpdateService: Updates disabled in dev mode");
            // Ensure status is idle so frontend doesn't show spinner.
            // Always notify so frontend clears isCheckingOnHover state.
            this.currentStatus = { type: "idle" };
            this.notifySubscribers();
            return;
          }
        } catch (err) {
          // Ignore errors (e.g. if modules not found), proceed to check
          log.debug("UpdateService: Error checking env:", err);
        }
      }
      this.impl.checkForUpdates();
    } else {
      log.debug("UpdateService: check() called but no implementation (CLI mode)");
    }
  }

  async download(): Promise<void> {
    if (this.impl) {
      await this.impl.downloadUpdate();
    }
  }

  install(): void {
    if (this.impl) {
      this.impl.installUpdate();
    }
  }

  onStatus(callback: (status: UpdateStatus) => void): () => void {
    // Send current status immediately
    callback(this.currentStatus);

    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notifySubscribers() {
    for (const sub of this.subscribers) {
      try {
        sub(this.currentStatus);
      } catch (err) {
        log.error("Error in UpdateService subscriber:", err);
      }
    }
  }
}
