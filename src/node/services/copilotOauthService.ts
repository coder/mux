import * as crypto from "crypto";
import type { Result } from "@/common/types/result";
import { Err, Ok } from "@/common/types/result";
import type { ProviderService } from "@/node/services/providerService";
import type { WindowService } from "@/node/services/windowService";
import { log } from "@/node/services/log";
import { createDeferred } from "@/node/utils/oauthUtils";
import { getErrorMessage } from "@/common/utils/errors";

const GITHUB_COPILOT_CLIENT_ID = "Ov23liCVKFN3jOo9R7HS";
const SCOPE = "read:user";
const POLLING_SAFETY_MARGIN_MS = 3000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_FLOW_TTL_MS = 60 * 1000;
// Only surface top-tier model families from the Copilot API
export const COPILOT_MODEL_PREFIXES = ["gpt-5", "claude-", "gemini-3", "grok-code"];

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";

interface DeviceFlow {
  flowId: string;
  deviceCode: string;
  interval: number;
  cancelled: boolean;
  timeout: ReturnType<typeof setTimeout>;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
  pollingStarted: boolean;
  resultPromise: Promise<Result<void, string>>;
  resolveResult: (result: Result<void, string>) => void;
}

export class CopilotOauthService {
  private readonly flows = new Map<string, DeviceFlow>();

  constructor(
    private readonly providerService: ProviderService,
    private readonly windowService?: WindowService
  ) {}

  async startDeviceFlow(): Promise<
    Result<{ flowId: string; verificationUri: string; userCode: string }, string>
  > {
    const flowId = crypto.randomUUID();

    try {
      const res = await fetch(GITHUB_DEVICE_CODE_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: GITHUB_COPILOT_CLIENT_ID,
          scope: SCOPE,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return Err(`GitHub device code request failed (${res.status}): ${text}`);
      }

      const data = (await res.json()) as {
        verification_uri?: string;
        user_code?: string;
        device_code?: string;
        interval?: number;
      };

      if (!data.verification_uri || !data.user_code || !data.device_code) {
        return Err("Invalid response from GitHub device code endpoint");
      }

      const { promise: resultPromise, resolve: resolveResult } =
        createDeferred<Result<void, string>>();

      const timeout = setTimeout(() => {
        void this.finishFlow(flowId, Err("Timed out waiting for GitHub authorization"));
      }, DEFAULT_TIMEOUT_MS);

      this.flows.set(flowId, {
        flowId,
        deviceCode: data.device_code,
        interval: data.interval ?? 5,
        cancelled: false,
        pollingStarted: false,
        timeout,
        cleanupTimeout: null,
        resultPromise,
        resolveResult,
      });

      log.debug(`Copilot OAuth device flow started (flowId=${flowId})`);

      return Ok({
        flowId,
        verificationUri: data.verification_uri,
        userCode: data.user_code,
      });
    } catch (error) {
      const message = getErrorMessage(error);
      return Err(`Failed to start device flow: ${message}`);
    }
  }

  async waitForDeviceFlow(
    flowId: string,
    opts?: { timeoutMs?: number }
  ): Promise<Result<void, string>> {
    const flow = this.flows.get(flowId);
    if (!flow) {
      return Err("Device flow not found");
    }

    // Start polling in background (guard against re-entrant calls, e.g. React StrictMode re-mount)
    if (!flow.pollingStarted) {
      flow.pollingStarted = true;
      void this.pollForToken(flow);
    }

    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<Result<void, string>>((resolve) => {
      timeoutHandle = setTimeout(() => {
        resolve(Err("Timed out waiting for GitHub authorization"));
      }, timeoutMs);
    });

    const result = await Promise.race([flow.resultPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }

    if (!result.success) {
      void this.finishFlow(flowId, result);
    }

    return result;
  }

  cancelDeviceFlow(flowId: string): void {
    const flow = this.flows.get(flowId);
    if (!flow) return;

    // Skip if the flow already completed (e.g. unmount cleanup after success)
    if (flow.cancelled) return;

    log.debug(`Copilot OAuth device flow cancelled (flowId=${flowId})`);
    this.finishFlow(flowId, Err("Device flow cancelled"));
  }

  dispose(): void {
    for (const flow of this.flows.values()) {
      clearTimeout(flow.timeout);
      if (flow.cleanupTimeout !== null) clearTimeout(flow.cleanupTimeout);
      flow.cancelled = true;
      try {
        flow.resolveResult(Err("App shutting down"));
      } catch {
        /* already resolved */
      }
    }
    this.flows.clear();
  }

  private async pollForToken(flow: DeviceFlow): Promise<void> {
    while (!flow.cancelled) {
      try {
        const res = await fetch(GITHUB_ACCESS_TOKEN_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: GITHUB_COPILOT_CLIENT_ID,
            device_code: flow.deviceCode,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }),
        });

        const data = (await res.json()) as {
          access_token?: string;
          error?: string;
          interval?: number;
        };

        // Re-check cancellation after the fetch round-trip to avoid
        // persisting credentials for a flow that was cancelled mid-request.
        if (flow.cancelled) return;

        if (data.access_token) {
          // Store token as apiKey for the github-copilot provider
          const persistResult = this.providerService.setConfig(
            "github-copilot",
            ["apiKey"],
            data.access_token
          );

          if (!persistResult.success) {
            void this.finishFlow(flow.flowId, Err(persistResult.error));
            return;
          }

          // Fetch available models from Copilot API (best-effort, non-blocking on failure)
          try {
            const modelsRes = await fetch(`${COPILOT_API_BASE_URL}/models`, {
              headers: {
                Authorization: `Bearer ${data.access_token}`,
                "Openai-Intent": "conversation-edits",
                Accept: "application/json",
              },
            });

            if (modelsRes.ok) {
              const modelsData = (await modelsRes.json()) as {
                data?: Array<{ id: string }>;
              };
              if (modelsData.data && modelsData.data.length > 0) {
                const modelIds = modelsData.data
                  .map((m) => m.id)
                  .filter((id) => COPILOT_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix)));
                if (modelIds.length > 0) {
                  this.providerService.setModels("github-copilot", modelIds);
                }
              }
            }
          } catch (e) {
            log.debug("Failed to fetch Copilot models after login", e);
          }

          log.debug(`Copilot OAuth completed successfully (flowId=${flow.flowId})`);
          this.windowService?.focusMainWindow();
          void this.finishFlow(flow.flowId, Ok(undefined));
          return;
        }

        if (data.error === "authorization_pending") {
          // Expected during normal flow — will retry after sleep below
        } else if (data.error === "slow_down") {
          flow.interval = data.interval ?? flow.interval + 5;
        } else if (data.error) {
          // Any other error
          void this.finishFlow(flow.flowId, Err(`GitHub OAuth error: ${data.error}`));
          return;
        }
      } catch (error) {
        if (flow.cancelled) return;
        const message = getErrorMessage(error);
        log.warn(`Copilot OAuth polling error (will retry): ${message}`);
        // Transient errors — fall through to sleep, then retry
      }

      // Sleep before next iteration (placed at end so the first poll happens immediately)
      await new Promise((resolve) =>
        setTimeout(resolve, flow.interval * 1000 + POLLING_SAFETY_MARGIN_MS)
      );
    }
  }

  private finishFlow(flowId: string, result: Result<void, string>): void {
    const flow = this.flows.get(flowId);
    if (!flow || flow.cancelled) return;

    flow.cancelled = true;
    clearTimeout(flow.timeout);

    try {
      flow.resolveResult(result);
    } catch {
      // Already resolved
    }

    // Keep completed flow briefly so callers can still await
    if (flow.cleanupTimeout !== null) {
      clearTimeout(flow.cleanupTimeout);
    }
    flow.cleanupTimeout = setTimeout(() => {
      this.flows.delete(flowId);
    }, COMPLETED_FLOW_TTL_MS);
  }
}
