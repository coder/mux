import { tool } from "ai";
import type { ToolFactory, ToolConfiguration } from "@/common/utils/tools/tools";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { StatusSetToolArgs, StatusSetToolResult } from "@/common/types/tools";
import { StatusScriptPoller } from "@/node/services/statusScriptPoller";

interface PollerState {
  emit: (status: { emoji?: string; message: string; url?: string }) => void;
  poller: StatusScriptPoller;
}

const pollersByWorkspaceId = new Map<string, PollerState>();

function getOrCreatePollerState(workspaceId: string): PollerState {
  const existing = pollersByWorkspaceId.get(workspaceId);
  if (existing) {
    return existing;
  }

  // Create with a mutable emitter reference so we can keep polling across streams
  // while still emitting through the latest AIService event emitter.
  const state: PollerState = {
    emit: () => {
      // overwritten on first use
    },
    poller: new StatusScriptPoller((status) => state.emit(status)),
  };
  pollersByWorkspaceId.set(workspaceId, state);
  return state;
}

/**
 * status_set tool (script-based)
 *
 * Registers a status script that mux executes (optionally repeatedly) to keep the workspace status fresh.
 * The script output is parsed into { emoji?, message, url? } and emitted as a WorkspaceChatMessage
 * of type "agent-status-update".
 */
export const createStatusSetTool: ToolFactory = (config: ToolConfiguration) => {
  return tool({
    description: TOOL_DEFINITIONS.status_set.description,
    inputSchema: TOOL_DEFINITIONS.status_set.schema,
    execute: (args: StatusSetToolArgs): StatusSetToolResult => {
      const workspaceId = config.workspaceId;
      if (!workspaceId) {
        return {
          success: false,
          error: "status_set requires workspaceId",
        };
      }

      const emit = config.emitAIEvent;
      if (!emit) {
        return {
          success: false,
          error: "status_set requires emitAIEvent",
        };
      }

      const state = getOrCreatePollerState(workspaceId);
      state.emit = (status) => {
        emit("agent-status-update", {
          type: "agent-status-update",
          workspaceId,
          status,
        });
      };

      const env = {
        ...(config.muxEnv ?? {}),
        ...(config.secrets ?? {}),
      };

      state.poller.set({
        workspaceId,
        runtime: config.runtime,
        cwd: config.cwd,
        env,
        script: args.script,
        pollIntervalMs: (args.poll_interval_s ?? 0) * 1000,
      });

      return { success: true };
    },
  });
};
