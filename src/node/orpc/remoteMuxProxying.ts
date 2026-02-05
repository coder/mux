import type { z } from "zod";
import * as schemas from "@/common/orpc/schemas";
import type {
  FrontendWorkspaceMetadataSchemaType,
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import { decodeRemoteWorkspaceId, encodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import type { ORPCContext } from "./context";
import { createRemoteClient } from "@/node/remote/remoteOrpcClient";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import assert from "node:assert/strict";

// -----------------------------------------------------------------------------
// Remote workspace proxying
// -----------------------------------------------------------------------------

export interface RemoteMuxOrpcClient {
  workspace: {
    list: (
      input: z.infer<typeof schemas.workspace.list.input>
    ) => Promise<FrontendWorkspaceMetadataSchemaType[]>;
    create: (
      input: z.infer<typeof schemas.workspace.create.input>
    ) => Promise<z.infer<typeof schemas.workspace.create.output>>;
    onMetadata: (
      input: z.infer<typeof schemas.workspace.onMetadata.input>,
      options?: { signal?: AbortSignal }
    ) => Promise<
      AsyncIterable<{
        workspaceId: string;
        metadata: FrontendWorkspaceMetadataSchemaType | null;
      }>
    >;
    activity: {
      list: (
        input: z.infer<typeof schemas.workspace.activity.list.input>
      ) => Promise<Record<string, WorkspaceActivitySnapshot>>;
      subscribe: (
        input: z.infer<typeof schemas.workspace.activity.subscribe.input>,
        options?: { signal?: AbortSignal }
      ) => Promise<
        AsyncIterable<{
          workspaceId: string;
          activity: WorkspaceActivitySnapshot | null;
        }>
      >;
    };
    onChat: (
      input: z.infer<typeof schemas.workspace.onChat.input>,
      options?: { signal?: AbortSignal }
    ) => Promise<AsyncIterable<WorkspaceChatMessage>>;
    sendMessage: (
      input: z.infer<typeof schemas.workspace.sendMessage.input>
    ) => Promise<z.infer<typeof schemas.workspace.sendMessage.output>>;
    answerAskUserQuestion: (
      input: z.infer<typeof schemas.workspace.answerAskUserQuestion.input>
    ) => Promise<z.infer<typeof schemas.workspace.answerAskUserQuestion.output>>;
    resumeStream: (
      input: z.infer<typeof schemas.workspace.resumeStream.input>
    ) => Promise<z.infer<typeof schemas.workspace.resumeStream.output>>;
    interruptStream: (
      input: z.infer<typeof schemas.workspace.interruptStream.input>
    ) => Promise<z.infer<typeof schemas.workspace.interruptStream.output>>;
    archive: (
      input: z.infer<typeof schemas.workspace.archive.input>
    ) => Promise<z.infer<typeof schemas.workspace.archive.output>>;
    unarchive: (
      input: z.infer<typeof schemas.workspace.unarchive.input>
    ) => Promise<z.infer<typeof schemas.workspace.unarchive.output>>;
    getInfo: (
      input: z.infer<typeof schemas.workspace.getInfo.input>
    ) => Promise<FrontendWorkspaceMetadataSchemaType | null>;
    getFullReplay: (
      input: z.infer<typeof schemas.workspace.getFullReplay.input>
    ) => Promise<WorkspaceChatMessage[]>;
    getSubagentTranscript: (
      input: z.infer<typeof schemas.workspace.getSubagentTranscript.input>
    ) => Promise<z.infer<typeof schemas.workspace.getSubagentTranscript.output>>;
  };
  agents: {
    list: (
      input: z.infer<typeof schemas.agents.list.input>
    ) => Promise<z.infer<typeof schemas.agents.list.output>>;
    get: (
      input: z.infer<typeof schemas.agents.get.input>
    ) => Promise<z.infer<typeof schemas.agents.get.output>>;
  };
  agentSkills: {
    list: (
      input: z.infer<typeof schemas.agentSkills.list.input>
    ) => Promise<z.infer<typeof schemas.agentSkills.list.output>>;
    listDiagnostics: (
      input: z.infer<typeof schemas.agentSkills.listDiagnostics.input>
    ) => Promise<z.infer<typeof schemas.agentSkills.listDiagnostics.output>>;
    get: (
      input: z.infer<typeof schemas.agentSkills.get.input>
    ) => Promise<z.infer<typeof schemas.agentSkills.get.output>>;
  };
}

export interface RemoteWorkspaceProxy {
  client: RemoteMuxOrpcClient;
  remoteWorkspaceId: string;
  serverId: string;
}

export function resolveRemoteWorkspaceProxy(
  context: ORPCContext,
  workspaceId: string
): RemoteWorkspaceProxy | null {
  const decoded = decodeRemoteWorkspaceId(workspaceId);
  if (!decoded) {
    return null;
  }

  const serverId = decoded.serverId.trim();
  const remoteWorkspaceId = decoded.remoteId.trim();

  assert(serverId.length > 0, "resolveRemoteWorkspaceProxy: decoded serverId must be non-empty");
  assert(
    remoteWorkspaceId.length > 0,
    "resolveRemoteWorkspaceProxy: decoded remoteWorkspaceId must be non-empty"
  );

  const config = context.config.loadConfigOrDefault();
  const server = config.remoteServers?.find((entry) => entry.id === serverId) ?? null;
  assert(server, `Remote server not found for id: ${serverId}`);

  const authToken = context.remoteServersService.getAuthToken({ id: serverId }) ?? undefined;
  const client = createRemoteClient<RemoteMuxOrpcClient>({ baseUrl: server.baseUrl, authToken });

  return { client, remoteWorkspaceId, serverId };
}

export function encodeRemoteIdBestEffort(serverId: string, remoteId: string): string {
  assert(typeof serverId === "string", "encodeRemoteIdBestEffort: serverId must be a string");
  assert(typeof remoteId === "string", "encodeRemoteIdBestEffort: remoteId must be a string");

  // Avoid double-encoding if a remote server ever returns already-encoded IDs.
  if (decodeRemoteWorkspaceId(remoteId) !== null) {
    return remoteId;
  }

  const trimmed = remoteId.trim();
  if (!trimmed) {
    // Keep rewriting tolerant/defensive.
    return remoteId;
  }

  return encodeRemoteWorkspaceId(serverId, trimmed);
}

export function getRemoteServersForWorkspaceViews(context: ORPCContext) {
  const config = context.config.loadConfigOrDefault();
  const servers = config.remoteServers ?? [];
  return servers.filter((server) => server.enabled !== false && server.projectMappings.length > 0);
}

export function buildRemoteProjectPathMap(
  projectMappings: Array<{ localProjectPath: string; remoteProjectPath: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const mapping of projectMappings) {
    const remoteProjectPath = stripTrailingSlashes(mapping.remoteProjectPath.trim());
    const localProjectPath = stripTrailingSlashes(mapping.localProjectPath.trim());

    if (!remoteProjectPath || !localProjectPath) {
      continue;
    }

    map.set(remoteProjectPath, localProjectPath);
  }

  return map;
}

export function rewriteRemoteFrontendWorkspaceMetadataForLocalProject(
  metadata: FrontendWorkspaceMetadataSchemaType,
  serverId: string,
  remoteProjectPathMap: ReadonlyMap<string, string>
): FrontendWorkspaceMetadataSchemaType | null {
  const normalizedProjectPath = stripTrailingSlashes(metadata.projectPath.trim());
  if (!normalizedProjectPath) {
    return null;
  }

  const localProjectPath = remoteProjectPathMap.get(normalizedProjectPath);
  if (!localProjectPath) {
    return null;
  }

  const rewritten = rewriteRemoteFrontendWorkspaceMetadataIds(metadata, serverId);

  let runtimeConfig = rewritten.runtimeConfig;

  // Backward-compatible: some mux versions redundantly included projectPath inside runtimeConfig.
  // When present, keep it aligned with the mapped (local) projectPath so UI code doesn't
  // accidentally use the remote path.
  const runtimeConfigUnknown: unknown = runtimeConfig;
  if (runtimeConfigUnknown && typeof runtimeConfigUnknown === "object") {
    const runtimeConfigRecord = runtimeConfigUnknown as Record<string, unknown>;
    const runtimeProjectPathRaw = runtimeConfigRecord.projectPath;
    if (typeof runtimeProjectPathRaw === "string") {
      const normalizedRuntimeProjectPath = stripTrailingSlashes(runtimeProjectPathRaw.trim());
      const mappedRuntimeProjectPath = remoteProjectPathMap.get(normalizedRuntimeProjectPath);

      if (mappedRuntimeProjectPath && mappedRuntimeProjectPath !== runtimeProjectPathRaw) {
        // Type assertion is safe: runtimeConfig is a Zod-inferred union that permits extra keys.
        // We cast through unknown to satisfy TS's non-overlapping union check.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        runtimeConfig = {
          ...runtimeConfigRecord,
          projectPath: mappedRuntimeProjectPath,
        } as unknown as FrontendWorkspaceMetadataSchemaType["runtimeConfig"];
      }
    }
  }

  if (rewritten.projectPath === localProjectPath && runtimeConfig === rewritten.runtimeConfig) {
    return rewritten;
  }

  return {
    ...rewritten,
    projectPath: localProjectPath,
    runtimeConfig,
  };
}

export async function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
  assert(Number.isFinite(ms) && ms >= 0, "sleepMs: ms must be a non-negative finite number");

  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve();
    };

    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function rewriteRemoteFrontendWorkspaceMetadataIds(
  metadata: FrontendWorkspaceMetadataSchemaType,
  serverId: string
): FrontendWorkspaceMetadataSchemaType {
  const next: FrontendWorkspaceMetadataSchemaType = { ...metadata };

  if (typeof next.id === "string") {
    next.id = encodeRemoteIdBestEffort(serverId, next.id);
  }

  if (typeof next.parentWorkspaceId === "string") {
    next.parentWorkspaceId = encodeRemoteIdBestEffort(serverId, next.parentWorkspaceId);
  }

  if (typeof next.sectionId === "string") {
    next.sectionId = encodeRemoteIdBestEffort(serverId, next.sectionId);
  }

  return next;
}

const TASK_TOOL_RESULT_ID_KEYS = new Set<string>([
  "workspaceId",
  "parentWorkspaceId",
  "sourceWorkspaceId",
  "taskId",
  // Snake_case variants used by task tools.
  "task_id",
  "task_ids",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function rewriteRemoteTaskToolPayloadIds(serverId: string, value: unknown): unknown {
  const seen = new WeakSet<object>();
  const MAX_DEPTH = 20;

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      return current;
    }

    if (Array.isArray(current)) {
      let changed = false;
      const next = current.map((entry) => {
        const rewritten = visit(entry, depth + 1);
        if (rewritten !== entry) {
          changed = true;
        }
        return rewritten;
      });
      return changed ? next : current;
    }

    if (!isPlainObject(current)) {
      return current;
    }

    if (seen.has(current)) {
      return current;
    }

    seen.add(current);

    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(current)) {
      let rewritten = entry;

      if (TASK_TOOL_RESULT_ID_KEYS.has(key)) {
        if (typeof entry === "string") {
          rewritten = encodeRemoteIdBestEffort(serverId, entry);
        } else if (Array.isArray(entry)) {
          let arrayChanged = false;

          const nextArray = entry.map((item) => {
            if (typeof item === "string") {
              const encoded = encodeRemoteIdBestEffort(serverId, item);
              if (encoded !== item) {
                arrayChanged = true;
              }
              return encoded;
            }

            const visited = visit(item, depth + 1);
            if (visited !== item) {
              arrayChanged = true;
            }
            return visited;
          });

          rewritten = arrayChanged ? nextArray : entry;
        } else {
          rewritten = visit(entry, depth + 1);
        }
      } else {
        rewritten = visit(entry, depth + 1);
      }

      if (rewritten !== entry) {
        changed = true;
      }

      next[key] = rewritten;
    }

    return changed ? next : current;
  };

  return visit(value, 0);
}

export function rewriteRemoteTaskToolPartsInMessage<T extends { parts: MuxMessage["parts"] }>(
  message: T,
  serverId: string
): T {
  let changed = false;

  const nextParts = message.parts.map((part) => {
    if (part.type !== "dynamic-tool") {
      return part;
    }

    const isTaskTool = part.toolName.startsWith("task");

    const rewrittenInput = isTaskTool
      ? rewriteRemoteTaskToolPayloadIds(serverId, part.input)
      : part.input;

    const rewrittenOutput =
      isTaskTool && part.state === "output-available"
        ? rewriteRemoteTaskToolPayloadIds(serverId, part.output)
        : part.state === "output-available"
          ? part.output
          : undefined;

    let nestedChanged = false;
    const nextNestedCalls = Array.isArray(part.nestedCalls)
      ? part.nestedCalls.map((call) => {
          if (typeof call.toolName !== "string" || !call.toolName.startsWith("task")) {
            return call;
          }

          const nextInput = rewriteRemoteTaskToolPayloadIds(serverId, call.input);
          const nextOutput =
            call.state === "output-available" && call.output !== undefined
              ? rewriteRemoteTaskToolPayloadIds(serverId, call.output)
              : call.output;

          if (nextInput === call.input && nextOutput === call.output) {
            return call;
          }

          nestedChanged = true;
          return {
            ...call,
            input: nextInput,
            output: nextOutput,
          };
        })
      : part.nestedCalls;

    const outputChanged =
      part.state === "output-available" && isTaskTool && rewrittenOutput !== part.output;

    if (rewrittenInput === part.input && !outputChanged && !nestedChanged) {
      return part;
    }

    changed = true;

    if (part.state === "output-available") {
      return {
        ...part,
        input: rewrittenInput,
        output: rewrittenOutput,
        nestedCalls: nextNestedCalls,
      };
    }

    return {
      ...part,
      input: rewrittenInput,
      nestedCalls: nextNestedCalls,
    };
  });

  if (!changed) {
    return message;
  }

  // Type assertion is safe: we only replace parts with the same part union type.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { ...message, parts: nextParts } as T;
}

export function rewriteRemoteWorkspaceChatMessageIds(
  message: WorkspaceChatMessage,
  serverId: string
): WorkspaceChatMessage {
  if (!message || typeof message !== "object") {
    return message;
  }

  if (message.type === "message") {
    return rewriteRemoteTaskToolPartsInMessage(message, serverId);
  }

  let changed = false;
  const next: WorkspaceChatMessage = { ...message };

  if ("workspaceId" in next && typeof next.workspaceId === "string") {
    const rewritten = encodeRemoteIdBestEffort(serverId, next.workspaceId);
    if (rewritten !== next.workspaceId) {
      next.workspaceId = rewritten;
      changed = true;
    }
  }

  if (next.type === "task-created" && typeof next.taskId === "string") {
    const rewritten = encodeRemoteIdBestEffort(serverId, next.taskId);
    if (rewritten !== next.taskId) {
      next.taskId = rewritten;
      changed = true;
    }
  }

  if (next.type === "session-usage-delta" && typeof next.sourceWorkspaceId === "string") {
    const rewritten = encodeRemoteIdBestEffort(serverId, next.sourceWorkspaceId);
    if (rewritten !== next.sourceWorkspaceId) {
      next.sourceWorkspaceId = rewritten;
      changed = true;
    }
  }

  if (next.type === "tool-call-start" && next.toolName.startsWith("task")) {
    const rewrittenArgs = rewriteRemoteTaskToolPayloadIds(serverId, next.args);
    if (rewrittenArgs !== next.args) {
      next.args = rewrittenArgs;
      changed = true;
    }
  }

  // Tools like task/task_await return workspace IDs that must be re-encoded locally.
  if (next.type === "tool-call-end" && next.toolName.startsWith("task")) {
    let rewrittenResult = rewriteRemoteTaskToolPayloadIds(serverId, next.result);

    // Some legacy tool result shapes wrap IDs inside result.metadata.id.
    // Best-effort: rewrite this nested field without over-encoding every `id`.
    if (isPlainObject(rewrittenResult)) {
      const record = rewrittenResult as Record<string, unknown>;
      const metadataValue = record.metadata;

      if (isPlainObject(metadataValue)) {
        const metadataRecord = metadataValue as Record<string, unknown>;
        const idValue = metadataRecord.id;

        if (typeof idValue === "string") {
          const rewrittenId = encodeRemoteIdBestEffort(serverId, idValue);

          if (rewrittenId !== idValue) {
            rewrittenResult = {
              ...record,
              metadata: {
                ...metadataRecord,
                id: rewrittenId,
              },
            };
          }
        }
      }
    }

    if (rewrittenResult !== next.result) {
      next.result = rewrittenResult;
      changed = true;
    }
  }

  return changed ? next : message;
}
