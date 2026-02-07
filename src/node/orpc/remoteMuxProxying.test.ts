import { describe, expect, test } from "bun:test";

import type {
  FrontendWorkspaceMetadataSchemaType,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import { encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";

import {
  rewriteRemoteFrontendWorkspaceMetadataForLocalProject,
  rewriteRemoteWorkspaceChatMessageIds,
} from "./remoteMuxProxying";

describe("remoteMuxProxying", () => {
  describe("rewriteRemoteWorkspaceChatMessageIds", () => {
    test("rewrites tool-call-start.args for task tools", () => {
      const serverId = "test-remote";

      const message: WorkspaceChatMessage = {
        type: "tool-call-start",
        workspaceId: "workspace-root",
        messageId: "message-1",
        toolCallId: "tool-call-1",
        toolName: "task/task_create",
        args: {
          workspaceId: "workspace-child",
          task_id: "task-child",
          unrelated: "leave-me-alone",
        },
        tokens: 0,
        timestamp: 0,
      };

      const rewritten = rewriteRemoteWorkspaceChatMessageIds(message, serverId);

      expect(rewritten.type).toBe("tool-call-start");
      if (rewritten.type !== "tool-call-start") {
        throw new Error(`Expected tool-call-start message but got: ${rewritten.type}`);
      }

      expect(rewritten.workspaceId).toBe(encodeRemoteWorkspaceId(serverId, "workspace-root"));

      const argsUnknown: unknown = rewritten.args;
      expect(argsUnknown && typeof argsUnknown).toBe("object");

      const argsRecord = argsUnknown as Record<string, unknown>;
      expect(argsRecord.workspaceId).toBe(encodeRemoteWorkspaceId(serverId, "workspace-child"));
      expect(argsRecord.task_id).toBe(encodeRemoteWorkspaceId(serverId, "task-child"));
      expect(argsRecord.unrelated).toBe("leave-me-alone");
    });

    test("rewrites legacy tool-call-end.result.metadata.id for task tools", () => {
      const serverId = "test-remote";

      const message: WorkspaceChatMessage = {
        type: "tool-call-end",
        workspaceId: "workspace-root",
        messageId: "message-1",
        toolCallId: "tool-call-1",
        toolName: "task/task_await",
        result: {
          metadata: {
            id: "workspace-child",
          },
          workspaceId: "workspace-from-result",
        },
        timestamp: 0,
      };

      const rewritten = rewriteRemoteWorkspaceChatMessageIds(message, serverId);

      expect(rewritten.type).toBe("tool-call-end");
      if (rewritten.type !== "tool-call-end") {
        throw new Error(`Expected tool-call-end message but got: ${rewritten.type}`);
      }

      const resultUnknown: unknown = rewritten.result;
      expect(resultUnknown && typeof resultUnknown).toBe("object");

      const resultRecord = resultUnknown as Record<string, unknown>;
      expect(resultRecord.workspaceId).toBe(
        encodeRemoteWorkspaceId(serverId, "workspace-from-result")
      );

      const metadataUnknown: unknown = resultRecord.metadata;
      expect(metadataUnknown && typeof metadataUnknown).toBe("object");

      const metadataRecord = metadataUnknown as Record<string, unknown>;
      expect(metadataRecord.id).toBe(encodeRemoteWorkspaceId(serverId, "workspace-child"));
    });
  });

  describe("rewriteRemoteFrontendWorkspaceMetadataForLocalProject", () => {
    test("maps runtimeConfig.projectPath (when present) to local projectPath", () => {
      const serverId = "test-remote";

      const remoteProjectPath = "/remote/project";
      const localProjectPath = "/local/project";

      const remoteProjectPathMap = new Map<string, string>([[remoteProjectPath, localProjectPath]]);

      const metadata: FrontendWorkspaceMetadataSchemaType = {
        id: "workspace-1",
        name: "branch-1",
        projectName: "project",
        projectPath: remoteProjectPath,
        runtimeConfig: {
          type: "local",
          projectPath: remoteProjectPath,
        } as unknown as FrontendWorkspaceMetadataSchemaType["runtimeConfig"],
        namedWorkspacePath: "/remote/project/.mux/workspace-1",
      };

      const rewritten = rewriteRemoteFrontendWorkspaceMetadataForLocalProject(
        metadata,
        serverId,
        remoteProjectPathMap
      );

      expect(rewritten).not.toBeNull();
      expect(rewritten?.id).toBe(encodeRemoteWorkspaceId(serverId, "workspace-1"));
      expect(rewritten?.projectPath).toBe(localProjectPath);

      const runtimeConfigUnknown: unknown = rewritten?.runtimeConfig;
      expect(runtimeConfigUnknown && typeof runtimeConfigUnknown).toBe("object");

      const runtimeConfigRecord = runtimeConfigUnknown as Record<string, unknown>;
      expect(runtimeConfigRecord.projectPath).toBe(localProjectPath);
    });
  });
});
