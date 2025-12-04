/**
 * Backend Telemetry Service
 *
 * Sends telemetry events to PostHog from the main process (Node.js).
 * This avoids ad-blocker issues that affect browser-side telemetry.
 *
 * Uses posthog-node which batches events and flushes asynchronously.
 */

import { PostHog } from "posthog-node";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { getMuxHome } from "@/common/constants/paths";
import { VERSION } from "@/version";
import type { TelemetryEventPayload, BaseTelemetryProperties } from "@/common/telemetry/payload";

// Default configuration (public keys, safe to commit)
const DEFAULT_POSTHOG_KEY = "phc_vF1bLfiD5MXEJkxojjsmV5wgpLffp678yhJd3w9Sl4G";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

// File to persist anonymous distinct ID across sessions
const TELEMETRY_ID_FILE = "telemetry_id";

/**
 * Check if we're running in a test environment
 */
function isTestEnvironment(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.VITEST !== undefined ||
    process.env.TEST_INTEGRATION === "1"
  );
}

/**
 * Get the version string for telemetry
 */
function getVersionString(): string {
  if (
    typeof VERSION === "object" &&
    VERSION !== null &&
    typeof (VERSION as Record<string, unknown>).git_describe === "string"
  ) {
    return (VERSION as { git_describe: string }).git_describe;
  }
  return "unknown";
}

export class TelemetryService {
  private client: PostHog | null = null;
  private distinctId: string | null = null;
  private enabled = true;
  private readonly muxHome: string;

  constructor(muxHome?: string) {
    this.muxHome = muxHome ?? getMuxHome();
  }

  /**
   * Initialize the PostHog client.
   * Should be called once on app startup.
   */
  async initialize(): Promise<void> {
    if (isTestEnvironment()) {
      return;
    }

    if (this.client) {
      console.warn("[TelemetryService] Already initialized");
      return;
    }

    // Load or generate distinct ID
    this.distinctId = await this.loadOrCreateDistinctId();

    this.client = new PostHog(DEFAULT_POSTHOG_KEY, {
      host: DEFAULT_POSTHOG_HOST,
      // Disable feature flags since we don't use them
      disableGeoip: true,
    });

    console.debug("[TelemetryService] Initialized", { host: DEFAULT_POSTHOG_HOST });
  }

  /**
   * Load existing distinct ID or create a new one.
   * Persisted in ~/.mux/telemetry_id for cross-session identity.
   */
  private async loadOrCreateDistinctId(): Promise<string> {
    const idPath = path.join(this.muxHome, TELEMETRY_ID_FILE);

    try {
      // Try to read existing ID
      const id = (await fs.readFile(idPath, "utf-8")).trim();
      if (id) {
        return id;
      }
    } catch {
      // File doesn't exist or read error, will create new ID
    }

    // Generate new ID
    const newId = randomUUID();

    try {
      // Ensure directory exists
      await fs.mkdir(this.muxHome, { recursive: true });
      await fs.writeFile(idPath, newId, "utf-8");
    } catch (err) {
      console.warn("[TelemetryService] Failed to persist distinct ID:", err);
    }

    return newId;
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.enabled && !isTestEnvironment();
  }

  /**
   * Set telemetry enabled state
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    console.log(`[TelemetryService] ${enabled ? "Enabled" : "Disabled"}`);
  }

  /**
   * Get base properties included with all events
   */
  private getBaseProperties(): BaseTelemetryProperties {
    return {
      version: getVersionString(),
      platform: process.platform,
      electronVersion: process.versions.electron ?? "unknown",
    };
  }

  /**
   * Track a telemetry event.
   * Events are silently ignored when disabled or in test environments.
   */
  capture(payload: TelemetryEventPayload): void {
    if (!this.isEnabled()) {
      return;
    }

    if (!this.client || !this.distinctId) {
      console.debug("[TelemetryService] Not initialized, skipping event:", payload.event);
      return;
    }

    // Merge base properties with event-specific properties
    const properties = {
      ...this.getBaseProperties(),
      ...payload.properties,
    };

    console.debug("[TelemetryService] Capturing event:", {
      event: payload.event,
      properties,
    });

    this.client.capture({
      distinctId: this.distinctId,
      event: payload.event,
      properties,
    });
  }

  /**
   * Shutdown telemetry and flush any pending events.
   * Should be called on app close.
   */
  async shutdown(): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      await this.client.shutdown();
    } catch (err) {
      console.warn("[TelemetryService] Error during shutdown:", err);
    }

    this.client = null;
    console.debug("[TelemetryService] Shut down");
  }
}
