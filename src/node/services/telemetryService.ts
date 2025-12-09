/**
 * Backend Telemetry Service
 *
 * Sends telemetry events to PostHog from the main process (Node.js).
 * This avoids ad-blocker issues that affect browser-side telemetry.
 *
 * Telemetry can be disabled by setting the MUX_DISABLE_TELEMETRY=1 env var.
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
 * Check if running in a CI/automation environment.
 * Covers major CI providers: GitHub Actions, GitLab CI, Jenkins, CircleCI,
 * Travis, Azure Pipelines, Bitbucket, TeamCity, Buildkite, etc.
 */
function isCIEnvironment(): boolean {
  return (
    // Generic CI indicator (set by most CI systems)
    process.env.CI === "true" ||
    process.env.CI === "1" ||
    // GitHub Actions
    process.env.GITHUB_ACTIONS === "true" ||
    // GitLab CI
    process.env.GITLAB_CI === "true" ||
    // Jenkins
    process.env.JENKINS_URL !== undefined ||
    // CircleCI
    process.env.CIRCLECI === "true" ||
    // Travis CI
    process.env.TRAVIS === "true" ||
    // Azure Pipelines
    process.env.TF_BUILD === "True" ||
    // Bitbucket Pipelines
    process.env.BITBUCKET_BUILD_NUMBER !== undefined ||
    // TeamCity
    process.env.TEAMCITY_VERSION !== undefined ||
    // Buildkite
    process.env.BUILDKITE === "true" ||
    // AWS CodeBuild
    process.env.CODEBUILD_BUILD_ID !== undefined ||
    // Drone CI
    process.env.DRONE === "true" ||
    // AppVeyor
    process.env.APPVEYOR === "True" ||
    // Vercel / Netlify (build environments)
    process.env.VERCEL === "1" ||
    process.env.NETLIFY === "true"
  );
}

/**
 * Check if telemetry is disabled via environment variable or automation context
 */
function isTelemetryDisabled(): boolean {
  return (
    process.env.MUX_DISABLE_TELEMETRY === "1" ||
    process.env.NODE_ENV === "test" ||
    process.env.JEST_WORKER_ID !== undefined ||
    process.env.VITEST !== undefined ||
    process.env.TEST_INTEGRATION === "1" ||
    isCIEnvironment()
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
  private readonly muxHome: string;

  constructor(muxHome?: string) {
    this.muxHome = muxHome ?? getMuxHome();
  }

  /**
   * Initialize the PostHog client.
   * Should be called once on app startup.
   */
  async initialize(): Promise<void> {
    if (isTelemetryDisabled()) {
      return;
    }

    if (this.client) {
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
    } catch {
      // Silently ignore persistence failures
    }

    return newId;
  }

  /**
   * Get base properties included with all events
   */
  private getBaseProperties(): BaseTelemetryProperties {
    return {
      version: getVersionString(),
      backend_platform: process.platform,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node ?? "unknown",
      bunVersion: process.versions.bun ?? "unknown",
    };
  }

  /**
   * Track a telemetry event.
   * Events are silently ignored when disabled.
   */
  capture(payload: TelemetryEventPayload): void {
    if (isTelemetryDisabled() || !this.client || !this.distinctId) {
      return;
    }

    // Merge base properties with event-specific properties
    const properties = {
      ...this.getBaseProperties(),
      ...payload.properties,
    };

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
    } catch {
      // Silently ignore shutdown errors
    }

    this.client = null;
  }
}
