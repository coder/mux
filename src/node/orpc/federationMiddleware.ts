import { os } from "@orpc/server";
import type { ORPCContext } from "./context";
import { decodeRemoteWorkspaceId } from "@/common/utils/remoteMuxIds";
import { createRemoteClient } from "@/node/remote/remoteOrpcClient";
import {
  buildRemoteProjectPathMap,
  encodeRemoteIdBestEffort,
  rewriteRemoteFrontendWorkspaceMetadataForLocalProject,
  rewriteRemoteFrontendWorkspaceMetadataIds,
  rewriteRemoteTaskToolPartsInMessage,
  rewriteRemoteTaskToolPayloadIds,
  rewriteRemoteWorkspaceChatMessageIds,
} from "./remoteMuxProxying";
import type {
  FrontendWorkspaceMetadataSchemaType,
  WorkspaceChatMessage,
} from "@/common/orpc/types";
import type { MuxMessage } from "@/common/types/message";
import assert from "node:assert/strict";

interface AnyOrpcClient {
  (input?: unknown, options?: { signal?: AbortSignal; lastEventId?: string }): Promise<unknown>;
  [key: string]: AnyOrpcClient;
}

const FEDERATION_ID_KEYS = new Set<string>([
  "workspaceId",
  "workspaceIds",
  "parentWorkspaceId",
  "sourceWorkspaceId",
  "taskId",
  "taskIds",
  // Snake_case variants used by task tools.
  "task_id",
  "task_ids",
  "sectionId",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }

  return Symbol.asyncIterator in value;
}

function resolveRemoteProcedure(client: AnyOrpcClient, path: readonly string[]): AnyOrpcClient {
  let current: AnyOrpcClient = client;
  for (const segment of path) {
    current = current[segment];
  }
  return current;
}

function createLinkedAbortController(signal?: AbortSignal): AbortController {
  const controller = new AbortController();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }

  return controller;
}

function wrapAsyncIterable(params: {
  iterable: AsyncIterable<unknown>;
  mapValue: (value: unknown) => unknown;
  abortController: AbortController;
}): AsyncIteratorObject<unknown, unknown, void> {
  const iterator = params.iterable[Symbol.asyncIterator]();

  const end = async (value: unknown) => {
    // Best-effort: abort the underlying HTTP stream if the local subscription ends early.
    params.abortController.abort();
    await iterator.return?.(value);
  };

  return {
    async next() {
      const result = await iterator.next();
      if (result.done) {
        return result;
      }

      return { done: false as const, value: params.mapValue(result.value) };
    },
    async return(value?: unknown) {
      await end(value);
      return { done: true as const, value };
    },
    async throw(error?: unknown) {
      await end(undefined);
      throw error;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function decodeRemoteIdForFederation(
  encodedId: string
): { serverId: string; remoteId: string } | null {
  const decoded = decodeRemoteWorkspaceId(encodedId);
  if (!decoded) {
    return null;
  }

  const serverId = decoded.serverId.trim();
  const remoteId = decoded.remoteId.trim();

  assert(serverId.length > 0, "decodeRemoteIdForFederation: serverId must be non-empty");
  assert(remoteId.length > 0, "decodeRemoteIdForFederation: remoteId must be non-empty");

  return { serverId, remoteId };
}

type FederationInputRewrite = {
  serverId: string;
  rewrittenInput: unknown;
  /** Set of raw remote IDs we decoded (useful for rewriting record keys on output). */
  decodedRemoteIds: ReadonlySet<string>;
};

function rewriteFederationInputIds(input: unknown): FederationInputRewrite | null {
  let serverId: string | null = null;
  const decodedRemoteIds = new Set<string>();

  const MAX_DEPTH = 20;
  const seen = new WeakSet<object>();

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

      if (FEDERATION_ID_KEYS.has(key)) {
        if (typeof entry === "string") {
          const decoded = decodeRemoteIdForFederation(entry);
          if (decoded) {
            if (!serverId) {
              serverId = decoded.serverId;
            } else {
              assert(
                serverId === decoded.serverId,
                "rewriteFederationInputIds: mixed remote server IDs are not supported"
              );
            }

            decodedRemoteIds.add(decoded.remoteId);
            rewritten = decoded.remoteId;
          }
        } else if (Array.isArray(entry)) {
          let arrayChanged = false;
          const nextArray = entry.map((item) => {
            if (typeof item === "string") {
              const decoded = decodeRemoteIdForFederation(item);
              if (decoded) {
                if (!serverId) {
                  serverId = decoded.serverId;
                } else {
                  assert(
                    serverId === decoded.serverId,
                    "rewriteFederationInputIds: mixed remote server IDs are not supported"
                  );
                }

                decodedRemoteIds.add(decoded.remoteId);
                arrayChanged = true;
                return decoded.remoteId;
              }

              return item;
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

  const rewrittenInput = visit(input, 0);

  if (!serverId) {
    return null;
  }

  return {
    serverId,
    rewrittenInput,
    decodedRemoteIds,
  };
}

function isFrontendWorkspaceMetadataLike(
  value: unknown
): value is FrontendWorkspaceMetadataSchemaType {
  if (!isPlainObject(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.projectPath === "string"
  );
}

function rewriteRemoteFrontendMetadataBestEffort(params: {
  metadata: FrontendWorkspaceMetadataSchemaType;
  serverId: string;
  remoteProjectPathMap: ReadonlyMap<string, string>;
}): FrontendWorkspaceMetadataSchemaType {
  const rewrittenForLocalProject = rewriteRemoteFrontendWorkspaceMetadataForLocalProject(
    params.metadata,
    params.serverId,
    params.remoteProjectPathMap
  );

  return rewrittenForLocalProject
    ? rewrittenForLocalProject
    : rewriteRemoteFrontendWorkspaceMetadataIds(params.metadata, params.serverId);
}

function rewriteFederationOutputValue(params: {
  value: unknown;
  serverId: string;
  remoteProjectPathMap: ReadonlyMap<string, string>;
  decodedRemoteIds: ReadonlySet<string>;
}): unknown {
  // Generic rewrite for nested tool payloads (workspaceId/taskId/etc).
  // Note: this does NOT rewrite metadata.id, hence the extra metadata pass below.
  const rewrittenByKeys = rewriteRemoteTaskToolPayloadIds(params.serverId, params.value);

  const MAX_DEPTH = 20;
  const seen = new WeakSet<object>();

  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) {
      return current;
    }

    if (current === null || current === undefined) {
      return current;
    }

    // Keep Workspace metadata shape rewriter separate so we can rewrite metadata.id and
    // optionally map projectPath (when remote project mappings exist).
    if (isFrontendWorkspaceMetadataLike(current)) {
      return rewriteRemoteFrontendMetadataBestEffort({
        metadata: current,
        serverId: params.serverId,
        remoteProjectPathMap: params.remoteProjectPathMap,
      });
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
      const nextKey = params.decodedRemoteIds.has(key)
        ? encodeRemoteIdBestEffort(params.serverId, key)
        : key;

      const nextValue = visit(entry, depth + 1);

      if (nextKey !== key || nextValue !== entry) {
        changed = true;
      }

      next[nextKey] = nextValue;
    }

    return changed ? next : current;
  };

  return visit(rewrittenByKeys, 0);
}

function rewriteSubagentTranscriptOutput(params: { value: unknown; serverId: string }): unknown {
  if (!isPlainObject(params.value)) {
    return params.value;
  }

  const messagesValue = params.value.messages;
  if (!Array.isArray(messagesValue)) {
    return params.value;
  }

  let changed = false;
  const nextMessages = messagesValue.map((message) => {
    const maybeMessage = message as MuxMessage;
    const rewritten = rewriteRemoteTaskToolPartsInMessage(maybeMessage, params.serverId);
    if (rewritten !== maybeMessage) {
      changed = true;
    }
    return rewritten;
  });

  return changed ? { ...params.value, messages: nextMessages } : params.value;
}

function isExactPath(path: readonly string[], expected: readonly string[]): boolean {
  if (path.length !== expected.length) {
    return false;
  }

  for (let i = 0; i < path.length; i += 1) {
    if (path[i] !== expected[i]) {
      return false;
    }
  }

  return true;
}

export function createFederationMiddleware() {
  return os.$context<ORPCContext>().middleware(async (options, input, output) => {
    const rewrittenInput = rewriteFederationInputIds(input);
    if (!rewrittenInput) {
      return options.next();
    }

    const config = options.context.config.loadConfigOrDefault();
    const server =
      config.remoteServers?.find((entry) => entry.id === rewrittenInput.serverId) ?? null;
    if (!server) {
      throw new Error(`Remote server not found: ${rewrittenInput.serverId}`);
    }

    if (server.enabled === false) {
      throw new Error(`Remote server is disabled: ${rewrittenInput.serverId}`);
    }

    const authToken =
      options.context.remoteServersService.getAuthToken({ id: rewrittenInput.serverId }) ??
      undefined;

    const client = createRemoteClient<AnyOrpcClient>({
      baseUrl: server.baseUrl,
      authToken,
    });

    const procedure = resolveRemoteProcedure(client, options.path);

    const remoteAbortController = createLinkedAbortController(options.signal);

    const remoteResult = await procedure(rewrittenInput.rewrittenInput, {
      signal: remoteAbortController.signal,
      lastEventId: options.lastEventId,
    });

    const remoteProjectPathMap = buildRemoteProjectPathMap(server.projectMappings);

    const rewriteValue = (value: unknown): unknown => {
      if (isExactPath(options.path, ["workspace", "getFullReplay"]) && Array.isArray(value)) {
        return value.map((entry) =>
          rewriteRemoteWorkspaceChatMessageIds(
            entry as WorkspaceChatMessage,
            rewrittenInput.serverId
          )
        );
      }

      if (isExactPath(options.path, ["workspace", "getSubagentTranscript"])) {
        return rewriteSubagentTranscriptOutput({ value, serverId: rewrittenInput.serverId });
      }

      return rewriteFederationOutputValue({
        value,
        serverId: rewrittenInput.serverId,
        remoteProjectPathMap,
        decodedRemoteIds: rewrittenInput.decodedRemoteIds,
      });
    };

    if (isAsyncIterable(remoteResult)) {
      const mapValue = (value: unknown) => {
        if (isExactPath(options.path, ["workspace", "onChat"])) {
          return rewriteRemoteWorkspaceChatMessageIds(
            value as WorkspaceChatMessage,
            rewrittenInput.serverId
          );
        }

        return rewriteValue(value);
      };

      return output(
        wrapAsyncIterable({
          iterable: remoteResult,
          mapValue,
          abortController: remoteAbortController,
        })
      );
    }

    return output(rewriteValue(remoteResult));
  });
}
