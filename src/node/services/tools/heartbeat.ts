import { tool } from "ai";
import assert from "@/common/utils/assert";
import type { ToolFactory } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { HeartbeatToolArgs, HeartbeatToolResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import {
  HEARTBEAT_DEFAULT_CONTEXT_MODE,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";

function hasProvided<K extends keyof HeartbeatToolArgs>(
  args: HeartbeatToolArgs,
  key: K
): args is HeartbeatToolArgs & { [P in K]-?: NonNullable<HeartbeatToolArgs[P]> } {
  return Object.prototype.hasOwnProperty.call(args, key) && args[key] != null;
}

function formatInterval(intervalMs: number): string {
  assert(
    Number.isInteger(intervalMs) &&
      intervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
      intervalMs <= HEARTBEAT_MAX_INTERVAL_MS,
    "formatInterval requires a supported heartbeat interval"
  );

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  if (intervalMs % hourMs === 0) {
    const hours = intervalMs / hourMs;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (intervalMs % minuteMs === 0) {
    const minutes = intervalMs / minuteMs;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `${intervalMs} ms`;
}

function summarize(
  result: Pick<HeartbeatToolResult & { success: true }, "action" | "settings">
): string {
  if (result.action === "unset") {
    return "Heartbeat settings removed for this workspace.";
  }

  const settings = result.settings;
  if (!settings) {
    return "No heartbeat settings are configured for this workspace.";
  }

  const status = settings.enabled ? "enabled" : "disabled";
  return `Heartbeat is ${status} for this workspace at ${formatInterval(settings.intervalMs)}.`;
}

export const createHeartbeatTool: ToolFactory = (config) =>
  tool({
    description: TOOL_DEFINITIONS.heartbeat.description,
    inputSchema: TOOL_DEFINITIONS.heartbeat.schema,
    execute: async (args): Promise<HeartbeatToolResult> => {
      try {
        const workspaceId = config.workspaceId;
        assert(workspaceId, "heartbeat tool requires workspaceId");

        const heartbeatService = config.workspaceHeartbeatService;
        if (!heartbeatService) {
          return { success: false, error: "Heartbeat service is unavailable" };
        }

        if (args.action === "get") {
          const settings = heartbeatService.getHeartbeatSettings(workspaceId);
          return {
            success: true,
            action: args.action,
            configured: settings != null,
            settings,
            summary: summarize({ action: args.action, settings }),
          };
        }

        if (args.action === "unset") {
          const unsetResult = await heartbeatService.unsetHeartbeatSettings(workspaceId);
          if (!unsetResult.success) {
            return { success: false, error: unsetResult.error };
          }
          const settings = heartbeatService.getHeartbeatSettings(workspaceId);
          return {
            success: true,
            action: args.action,
            configured: settings != null,
            settings,
            summary: summarize({ action: args.action, settings }),
          };
        }

        const currentSettings = heartbeatService.getHeartbeatSettings(workspaceId);
        const defaultIntervalMs = heartbeatService.getHeartbeatDefaultIntervalMs();
        assert(
          Number.isInteger(defaultIntervalMs) &&
            defaultIntervalMs >= HEARTBEAT_MIN_INTERVAL_MS &&
            defaultIntervalMs <= HEARTBEAT_MAX_INTERVAL_MS,
          "heartbeat default interval must be within supported bounds"
        );

        const nextSettings = {
          enabled: hasProvided(args, "enabled") ? args.enabled : (currentSettings?.enabled ?? true),
          intervalMs: hasProvided(args, "intervalMs")
            ? args.intervalMs
            : (currentSettings?.intervalMs ?? defaultIntervalMs),
          contextMode: hasProvided(args, "contextMode")
            ? args.contextMode
            : (currentSettings?.contextMode ?? HEARTBEAT_DEFAULT_CONTEXT_MODE),
          ...(hasProvided(args, "message") ? { message: args.message } : {}),
        };

        const setResult = await heartbeatService.setHeartbeatSettings(workspaceId, nextSettings);
        if (!setResult.success) {
          return { success: false, error: setResult.error };
        }

        const settings = heartbeatService.getHeartbeatSettings(workspaceId);
        return {
          success: true,
          action: args.action,
          configured: settings != null,
          settings,
          summary: summarize({ action: args.action, settings }),
        };
      } catch (error) {
        return { success: false, error: getErrorMessage(error) };
      }
    },
  });
