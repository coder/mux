import { os } from "@orpc/server";
import * as schemas from "@/common/orpc/schemas";
import type { ORPCContext } from "./context";
import {
  MUX_GATEWAY_ORIGIN,
  MUX_GATEWAY_SESSION_EXPIRED_MESSAGE,
} from "@/common/constants/muxGatewayOAuth";
import { Err, Ok } from "@/common/types/result";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import { generateWorkspaceIdentity } from "@/node/services/workspaceTitleGenerator";
import type {
  UpdateStatus,
  WorkspaceActivitySnapshot,
  WorkspaceChatMessage,
  WorkspaceStatsSnapshot,
  FrontendWorkspaceMetadataSchemaType,
} from "@/common/orpc/types";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SshPromptEvent, SshPromptRequest } from "@/common/orpc/schemas/ssh";
import {
  createAuthMiddleware,
  extractClientIpAddress,
  extractCookieValues,
  getFirstHeaderValue,
} from "./authMiddleware";
import { createAsyncMessageQueue } from "@/common/utils/asyncMessageQueue";
import { clearLogFiles, getLogFilePath } from "@/node/services/log";
import type { LogEntry } from "@/node/services/logBuffer";
import { clearLogEntries, subscribeLogFeed } from "@/node/services/logBuffer";
import { createReplayBufferedStreamMessageRelay } from "./replayBufferedStreamMessageRelay";

import { createRuntime, checkRuntimeAvailability } from "@/node/runtime/runtimeFactory";
import { createRuntimeForWorkspace } from "@/node/runtime/runtimeHelpers";
import { hasNonEmptyPlanFile, readPlanFile } from "@/node/utils/runtime/helpers";
import { secretsToRecord } from "@/common/types/secrets";
import { roundToBase2 } from "@/common/telemetry/utils";
import { createAsyncEventQueue } from "@/common/utils/asyncEventIterator";
import {
  DEFAULT_LAYOUT_PRESETS_CONFIG,
  isLayoutPresetsConfigEmpty,
  normalizeLayoutPresetsConfig,
} from "@/common/types/uiLayouts";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isValidModelFormat, normalizeGatewayModel } from "@/common/utils/ai/models";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeSubagentAiDefaults,
  normalizeTaskSettings,
} from "@/common/types/tasks";
import {
  normalizeRuntimeEnablement,
  RUNTIME_ENABLEMENT_IDS,
  type RuntimeEnablementId,
} from "@/common/types/runtime";
import {
  discoverAgentSkills,
  discoverAgentSkillsDiagnostics,
  readAgentSkill,
} from "@/node/services/agentSkills/agentSkillsService";
import {
  discoverAgentDefinitions,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { isWorkspaceArchived } from "@/common/utils/archive";
import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";
import * as path from "node:path";

import type { MuxMessage } from "@/common/types/message";
import { coerceThinkingLevel } from "@/common/types/thinking";
import { normalizeLegacyMuxMetadata } from "@/node/utils/messages/legacy";
import { log } from "@/node/services/log";
import { SERVER_AUTH_SESSION_COOKIE_NAME } from "@/node/services/serverAuthService";
import {
  readSubagentTranscriptArtifactsFile,
  type SubagentTranscriptArtifactIndexEntry,
} from "@/node/services/subagentTranscriptArtifacts";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * Resolves runtime and discovery path for agent operations.
 * - When workspaceId is provided: uses workspace's runtime config (SSH, local, worktree)
 * - When only projectPath is provided: uses local runtime with project path
 * - When disableWorkspaceAgents is true: still uses workspace runtime but discovers from projectPath
 */
async function resolveAgentDiscoveryContext(
  context: ORPCContext,
  input: { projectPath?: string; workspaceId?: string; disableWorkspaceAgents?: boolean }
): Promise<{
  runtime: ReturnType<typeof createRuntime>;
  discoveryPath: string;
  metadata?: WorkspaceMetadata;
}> {
  if (!input.projectPath && !input.workspaceId) {
    throw new Error("Either projectPath or workspaceId must be provided");
  }

  if (input.workspaceId) {
    const metadataResult = await context.aiService.getWorkspaceMetadata(input.workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }
    const metadata = metadataResult.data;
    const runtime = createRuntimeForWorkspace(metadata);
    // When workspace agents disabled, discover from project path instead of worktree
    // (but still use the workspace's runtime for SSH compatibility)
    const discoveryPath = input.disableWorkspaceAgents
      ? metadata.projectPath
      : runtime.getWorkspacePath(metadata.projectPath, metadata.name);
    return { runtime, discoveryPath, metadata };
  }

  // No workspace - use local runtime with project path
  const runtime = createRuntime(
    { type: "local", srcBaseDir: context.config.srcDir },
    { projectPath: input.projectPath! }
  );
  return { runtime, discoveryPath: input.projectPath! };
}

function isErrnoWithCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

function isPathInsideDir(dirPath: string, filePath: string): boolean {
  const resolvedDir = path.resolve(dirPath);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedDir, resolvedFile);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeMuxMessageFromDisk(value: unknown): MuxMessage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  // Older history may have createdAt serialized as a string; coerce back to Date for ORPC.
  const obj = value as { createdAt?: unknown };
  if (typeof obj.createdAt === "string") {
    const parsed = new Date(obj.createdAt);
    if (Number.isFinite(parsed.getTime())) {
      obj.createdAt = parsed;
    } else {
      delete obj.createdAt;
    }
  }

  return normalizeLegacyMuxMetadata(value as MuxMessage);
}

async function readChatJsonlAllowMissing(params: {
  chatPath: string;
  logLabel: string;
}): Promise<MuxMessage[] | null> {
  try {
    const data = await fsPromises.readFile(params.chatPath, "utf-8");
    const lines = data.split("\n").filter((line) => line.trim());
    const messages: MuxMessage[] = [];

    for (let i = 0; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as unknown;
        const message = normalizeMuxMessageFromDisk(parsed);
        if (message) {
          messages.push(message);
        }
      } catch (parseError) {
        log.warn(
          `Skipping malformed JSON at line ${i + 1} in ${params.logLabel}:`,
          getErrorMessage(parseError),
          "\nLine content:",
          lines[i].substring(0, 100) + (lines[i].length > 100 ? "..." : "")
        );
      }
    }

    return messages;
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }

    throw error;
  }
}

async function readPartialJsonBestEffort(partialPath: string): Promise<MuxMessage | null> {
  try {
    const raw = await fsPromises.readFile(partialPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeMuxMessageFromDisk(parsed);
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }

    // Never fail transcript viewing because partial.json is corrupted.
    log.warn("Failed to read partial.json for transcript", {
      partialPath,
      error: getErrorMessage(error),
    });
    return null;
  }
}

function mergePartialIntoHistory(messages: MuxMessage[], partial: MuxMessage | null): MuxMessage[] {
  if (!partial) {
    return messages;
  }

  const partialSeq = partial.metadata?.historySequence;
  if (partialSeq === undefined) {
    return [...messages, partial];
  }

  const existingIndex = messages.findIndex((m) => m.metadata?.historySequence === partialSeq);
  if (existingIndex >= 0) {
    const existing = messages[existingIndex];
    const shouldReplace = (partial.parts?.length ?? 0) > (existing.parts?.length ?? 0);
    if (!shouldReplace) {
      return messages;
    }

    const next = [...messages];
    next[existingIndex] = partial;
    return next;
  }

  // Insert by historySequence to keep ordering stable.
  const insertIndex = messages.findIndex((m) => {
    const seq = m.metadata?.historySequence;
    return typeof seq === "number" && seq > partialSeq;
  });

  if (insertIndex < 0) {
    return [...messages, partial];
  }

  const next = [...messages];
  next.splice(insertIndex, 0, partial);
  return next;
}

async function findSubagentTranscriptEntryByScanningSessions(params: {
  sessionsDir: string;
  taskId: string;
}): Promise<{ workspaceId: string; entry: SubagentTranscriptArtifactIndexEntry } | null> {
  let best: { workspaceId: string; entry: SubagentTranscriptArtifactIndexEntry } | null = null;

  let dirents: Array<{ name: string; isDirectory: () => boolean }> = [];
  try {
    dirents = await fsPromises.readdir(params.sessionsDir, { withFileTypes: true });
  } catch (error: unknown) {
    if (isErrnoWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const workspaceId = dirent.name;
    if (!workspaceId) {
      continue;
    }

    const sessionDir = path.join(params.sessionsDir, workspaceId);
    const artifacts = await readSubagentTranscriptArtifactsFile(sessionDir);
    const entry = artifacts.artifactsByChildTaskId[params.taskId];
    if (!entry) {
      continue;
    }

    if (!best || entry.updatedAtMs > best.entry.updatedAtMs) {
      best = { workspaceId, entry };
    }
  }

  return best;
}

async function getCurrentServerAuthSessionId(context: ORPCContext): Promise<string | null> {
  const sessionTokens = extractCookieValues(
    context.headers?.cookie,
    SERVER_AUTH_SESSION_COOKIE_NAME
  );
  if (sessionTokens.length === 0) {
    return null;
  }

  for (const sessionToken of sessionTokens) {
    const validation = await context.serverAuthService.validateSessionToken(sessionToken, {
      userAgent: getFirstHeaderValue(context.headers, "user-agent"),
      ipAddress: extractClientIpAddress(context.headers),
    });

    if (validation?.sessionId) {
      return validation.sessionId;
    }
  }

  return null;
}

export const router = (authToken?: string) => {
  const t = os.$context<ORPCContext>().use(createAuthMiddleware(authToken));

  return t.router({
    tokenizer: {
      countTokens: t
        .input(schemas.tokenizer.countTokens.input)
        .output(schemas.tokenizer.countTokens.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokens(input.model, input.text);
        }),
      countTokensBatch: t
        .input(schemas.tokenizer.countTokensBatch.input)
        .output(schemas.tokenizer.countTokensBatch.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.countTokensBatch(input.model, input.texts);
        }),
      calculateStats: t
        .input(schemas.tokenizer.calculateStats.input)
        .output(schemas.tokenizer.calculateStats.output)
        .handler(async ({ context, input }) => {
          return context.tokenizerService.calculateStats(
            input.workspaceId,
            input.messages,
            input.model,
            context.providerService.getConfig()
          );
        }),
    },
    splashScreens: {
      getViewedSplashScreens: t
        .input(schemas.splashScreens.getViewedSplashScreens.input)
        .output(schemas.splashScreens.getViewedSplashScreens.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          return config.viewedSplashScreens ?? [];
        }),
      markSplashScreenViewed: t
        .input(schemas.splashScreens.markSplashScreenViewed.input)
        .output(schemas.splashScreens.markSplashScreenViewed.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const viewed = config.viewedSplashScreens ?? [];
            if (!viewed.includes(input.splashId)) {
              viewed.push(input.splashId);
            }
            return {
              ...config,
              viewedSplashScreens: viewed,
            };
          });
        }),
    },
    server: {
      getLaunchProject: t
        .input(schemas.server.getLaunchProject.input)
        .output(schemas.server.getLaunchProject.output)
        .handler(async ({ context }) => {
          return context.serverService.getLaunchProject();
        }),
      getSshHost: t
        .input(schemas.server.getSshHost.input)
        .output(schemas.server.getSshHost.output)
        .handler(({ context }) => {
          return context.serverService.getSshHost() ?? null;
        }),
      setSshHost: t
        .input(schemas.server.setSshHost.input)
        .output(schemas.server.setSshHost.output)
        .handler(async ({ context, input }) => {
          // Update in-memory value
          context.serverService.setSshHost(input.sshHost ?? undefined);
          // Persist to config file
          await context.config.editConfig((config) => ({
            ...config,
            serverSshHost: input.sshHost ?? undefined,
          }));
        }),
      getApiServerStatus: t
        .input(schemas.server.getApiServerStatus.input)
        .output(schemas.server.getApiServerStatus.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          const configuredBindHost = config.apiServerBindHost ?? null;
          const configuredServeWebUi = config.apiServerServeWebUi === true;
          const configuredPort = config.apiServerPort ?? null;

          const info = context.serverService.getServerInfo();

          return {
            running: info !== null,
            baseUrl: info?.baseUrl ?? null,
            bindHost: info?.bindHost ?? null,
            port: info?.port ?? null,
            networkBaseUrls: info?.networkBaseUrls ?? [],
            token: info?.token ?? null,
            configuredBindHost,
            configuredPort,
            configuredServeWebUi,
          };
        }),
      setApiServerSettings: t
        .input(schemas.server.setApiServerSettings.input)
        .output(schemas.server.setApiServerSettings.output)
        .handler(async ({ context, input }) => {
          const prevConfig = context.config.loadConfigOrDefault();
          const prevBindHost = prevConfig.apiServerBindHost;
          const prevServeWebUi = prevConfig.apiServerServeWebUi;
          const prevPort = prevConfig.apiServerPort;
          const wasRunning = context.serverService.isServerRunning();

          const bindHost = input.bindHost?.trim() ? input.bindHost.trim() : undefined;
          const serveWebUi =
            input.serveWebUi === undefined
              ? prevServeWebUi
              : input.serveWebUi === true
                ? true
                : undefined;
          const port = input.port === null || input.port === 0 ? undefined : input.port;

          if (wasRunning) {
            await context.serverService.stopServer();
          }

          await context.config.editConfig((config) => {
            config.apiServerServeWebUi = serveWebUi;
            config.apiServerBindHost = bindHost;
            config.apiServerPort = port;
            return config;
          });

          if (process.env.MUX_NO_API_SERVER !== "1") {
            const authToken = context.serverService.getApiAuthToken();
            if (!authToken) {
              throw new Error("API server auth token not initialized");
            }

            const envPort = process.env.MUX_SERVER_PORT
              ? Number.parseInt(process.env.MUX_SERVER_PORT, 10)
              : undefined;
            const portToUse = envPort ?? port ?? 0;
            const hostToUse = bindHost ?? "127.0.0.1";

            try {
              await context.serverService.startServer({
                muxHome: context.config.rootDir,
                context,
                authToken,
                serveStatic: serveWebUi === true,
                host: hostToUse,
                port: portToUse,
              });
            } catch (error) {
              await context.config.editConfig((config) => {
                config.apiServerServeWebUi = prevServeWebUi;
                config.apiServerBindHost = prevBindHost;
                config.apiServerPort = prevPort;
                return config;
              });

              if (wasRunning) {
                const portToRestore = envPort ?? prevPort ?? 0;
                const hostToRestore = prevBindHost ?? "127.0.0.1";

                try {
                  await context.serverService.startServer({
                    muxHome: context.config.rootDir,
                    context,
                    serveStatic: prevServeWebUi === true,
                    authToken,
                    host: hostToRestore,
                    port: portToRestore,
                  });
                } catch {
                  // Best effort - we'll surface the original error.
                }
              }

              throw error;
            }
          }

          const nextConfig = context.config.loadConfigOrDefault();
          const configuredBindHost = nextConfig.apiServerBindHost ?? null;
          const configuredServeWebUi = nextConfig.apiServerServeWebUi === true;
          const configuredPort = nextConfig.apiServerPort ?? null;

          const info = context.serverService.getServerInfo();

          return {
            running: info !== null,
            baseUrl: info?.baseUrl ?? null,
            bindHost: info?.bindHost ?? null,
            port: info?.port ?? null,
            networkBaseUrls: info?.networkBaseUrls ?? [],
            token: info?.token ?? null,
            configuredBindHost,
            configuredPort,
            configuredServeWebUi,
          };
        }),
    },
    serverAuth: {
      listSessions: t
        .input(schemas.serverAuth.listSessions.input)
        .output(schemas.serverAuth.listSessions.output)
        .handler(async ({ context }) => {
          const currentSessionId = await getCurrentServerAuthSessionId(context);
          return context.serverAuthService.listSessions(currentSessionId);
        }),
      revokeSession: t
        .input(schemas.serverAuth.revokeSession.input)
        .output(schemas.serverAuth.revokeSession.output)
        .handler(async ({ context, input }) => {
          const removed = await context.serverAuthService.revokeSession(input.sessionId);
          return { removed };
        }),
      revokeOtherSessions: t
        .input(schemas.serverAuth.revokeOtherSessions.input)
        .output(schemas.serverAuth.revokeOtherSessions.output)
        .handler(async ({ context }) => {
          const currentSessionId = await getCurrentServerAuthSessionId(context);
          const revokedCount =
            await context.serverAuthService.revokeOtherSessions(currentSessionId);
          return { revokedCount };
        }),
    },
    features: {
      getStatsTabState: t
        .input(schemas.features.getStatsTabState.input)
        .output(schemas.features.getStatsTabState.output)
        .handler(async ({ context }) => {
          const state = await context.featureFlagService.getStatsTabState();
          context.sessionTimingService.setStatsTabState(state);
          return state;
        }),
      setStatsTabOverride: t
        .input(schemas.features.setStatsTabOverride.input)
        .output(schemas.features.setStatsTabOverride.output)
        .handler(async ({ context, input }) => {
          const state = await context.featureFlagService.setStatsTabOverride(input.override);
          context.sessionTimingService.setStatsTabState(state);
          return state;
        }),
    },
    config: {
      getConfig: t
        .input(schemas.config.getConfig.input)
        .output(schemas.config.getConfig.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          // Determine governor enrollment: requires both URL and token
          const muxGovernorUrl = config.muxGovernorUrl ?? null;
          const muxGovernorEnrolled = Boolean(config.muxGovernorUrl && config.muxGovernorToken);
          return {
            taskSettings: config.taskSettings ?? DEFAULT_TASK_SETTINGS,
            muxGatewayEnabled: config.muxGatewayEnabled,
            muxGatewayModels: config.muxGatewayModels,
            defaultModel: config.defaultModel,
            hiddenModels: config.hiddenModels,
            preferredCompactionModel: config.preferredCompactionModel,
            stopCoderWorkspaceOnArchive: config.stopCoderWorkspaceOnArchive !== false,
            runtimeEnablement: normalizeRuntimeEnablement(config.runtimeEnablement),
            defaultRuntime: config.defaultRuntime ?? null,
            agentAiDefaults: config.agentAiDefaults ?? {},
            // Legacy fields (downgrade compatibility)
            subagentAiDefaults: config.subagentAiDefaults ?? {},
            // Mux Governor enrollment status (safe fields only - token never exposed)
            muxGovernorUrl,
            muxGovernorEnrolled,
          };
        }),
      updateAgentAiDefaults: t
        .input(schemas.config.updateAgentAiDefaults.input)
        .output(schemas.config.updateAgentAiDefaults.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalized = normalizeAgentAiDefaults(input.agentAiDefaults);

            const legacySubagentDefaultsRaw: Record<string, unknown> = {};
            for (const [agentType, entry] of Object.entries(normalized)) {
              if (agentType === "plan" || agentType === "exec" || agentType === "compact") {
                continue;
              }
              legacySubagentDefaultsRaw[agentType] = entry;
            }

            const legacySubagentDefaults = normalizeSubagentAiDefaults(legacySubagentDefaultsRaw);

            return {
              ...config,
              agentAiDefaults: Object.keys(normalized).length > 0 ? normalized : undefined,
              // Legacy fields (downgrade compatibility)
              subagentAiDefaults:
                Object.keys(legacySubagentDefaults).length > 0 ? legacySubagentDefaults : undefined,
            };
          });
        }),
      updateMuxGatewayPrefs: t
        .input(schemas.config.updateMuxGatewayPrefs.input)
        .output(schemas.config.updateMuxGatewayPrefs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const nextModels = Array.from(new Set(input.muxGatewayModels));
            nextModels.sort();

            return {
              ...config,
              muxGatewayEnabled: input.muxGatewayEnabled ? undefined : false,
              // Persist explicit empty selections so startup migration doesn't
              // rehydrate stale legacy localStorage values.
              muxGatewayModels: nextModels,
            };
          });
          // Notify subscribers (useProvidersConfig) so the frontend picks up the
          // new gateway enabled/models state without needing localStorage.
          context.providerService.notifyConfigChanged();
        }),
      updateModelPreferences: t
        .input(schemas.config.updateModelPreferences.input)
        .output(schemas.config.updateModelPreferences.output)
        .handler(async ({ context, input }) => {
          const normalizeModelString = (value: string): string | undefined => {
            const trimmed = value.trim();
            if (!trimmed) {
              return undefined;
            }

            // Reject malformed mux-gateway strings ("mux-gateway:provider" without "/model").
            if (trimmed.startsWith("mux-gateway:") && !trimmed.includes("/")) {
              return undefined;
            }

            const normalized = normalizeGatewayModel(trimmed);
            if (!isValidModelFormat(normalized)) {
              return undefined;
            }

            return normalized;
          };

          await context.config.editConfig((config) => {
            const next = { ...config };

            if (input.defaultModel !== undefined) {
              next.defaultModel = normalizeModelString(input.defaultModel);
            }

            if (input.hiddenModels !== undefined) {
              const seen = new Set<string>();
              const normalizedHidden: string[] = [];

              for (const modelString of input.hiddenModels) {
                const normalized = normalizeModelString(modelString);
                if (!normalized) continue;
                if (seen.has(normalized)) continue;
                seen.add(normalized);
                normalizedHidden.push(normalized);
              }

              next.hiddenModels = normalizedHidden;
            }

            if (input.preferredCompactionModel !== undefined) {
              next.preferredCompactionModel = normalizeModelString(input.preferredCompactionModel);
            }

            return next;
          });
        }),
      updateCoderPrefs: t
        .input(schemas.config.updateCoderPrefs.input)
        .output(schemas.config.updateCoderPrefs.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            return {
              ...config,
              // Default ON: store `false` only.
              stopCoderWorkspaceOnArchive: input.stopCoderWorkspaceOnArchive ? undefined : false,
            };
          });
        }),
      updateRuntimeEnablement: t
        .input(schemas.config.updateRuntimeEnablement.input)
        .output(schemas.config.updateRuntimeEnablement.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const shouldUpdateRuntimeEnablement = input.runtimeEnablement !== undefined;
            const shouldUpdateDefaultRuntime = input.defaultRuntime !== undefined;
            const shouldUpdateOverridesEnabled = input.runtimeOverridesEnabled !== undefined;
            const projectPath = input.projectPath?.trim();

            if (
              !shouldUpdateRuntimeEnablement &&
              !shouldUpdateDefaultRuntime &&
              !shouldUpdateOverridesEnabled
            ) {
              return config;
            }

            const runtimeEnablementOverrides =
              input.runtimeEnablement == null
                ? undefined
                : (() => {
                    const normalized = normalizeRuntimeEnablement(input.runtimeEnablement);
                    const disabled: Partial<Record<RuntimeEnablementId, false>> = {};

                    for (const runtimeId of RUNTIME_ENABLEMENT_IDS) {
                      if (!normalized[runtimeId]) {
                        disabled[runtimeId] = false;
                      }
                    }

                    return Object.keys(disabled).length > 0 ? disabled : undefined;
                  })();

            const defaultRuntime = input.defaultRuntime ?? undefined;
            const runtimeOverridesEnabled =
              input.runtimeOverridesEnabled === true ? true : undefined;

            if (projectPath) {
              const project = config.projects.get(projectPath);
              if (!project) {
                log.warn("Runtime settings update requested for missing project", { projectPath });
                return config;
              }

              const nextProject = { ...project };

              if (shouldUpdateRuntimeEnablement) {
                if (runtimeEnablementOverrides) {
                  nextProject.runtimeEnablement = runtimeEnablementOverrides;
                } else {
                  delete nextProject.runtimeEnablement;
                }
              }

              if (shouldUpdateDefaultRuntime) {
                if (defaultRuntime !== undefined) {
                  nextProject.defaultRuntime = defaultRuntime;
                } else {
                  delete nextProject.defaultRuntime;
                }
              }

              if (shouldUpdateOverridesEnabled) {
                if (runtimeOverridesEnabled) {
                  nextProject.runtimeOverridesEnabled = true;
                } else {
                  delete nextProject.runtimeOverridesEnabled;
                }
              }
              const nextProjects = new Map(config.projects);
              nextProjects.set(projectPath, nextProject);
              return { ...config, projects: nextProjects };
            }

            const next = { ...config };
            if (shouldUpdateRuntimeEnablement) {
              next.runtimeEnablement = runtimeEnablementOverrides;
            }

            if (shouldUpdateDefaultRuntime) {
              next.defaultRuntime = defaultRuntime;
            }

            return next;
          });
        }),
      saveConfig: t
        .input(schemas.config.saveConfig.input)
        .output(schemas.config.saveConfig.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalizedTaskSettings = normalizeTaskSettings(input.taskSettings);
            const result = { ...config, taskSettings: normalizedTaskSettings };

            if (input.agentAiDefaults !== undefined) {
              const normalized = normalizeAgentAiDefaults(input.agentAiDefaults);
              result.agentAiDefaults = Object.keys(normalized).length > 0 ? normalized : undefined;

              if (input.subagentAiDefaults === undefined) {
                const legacySubagentDefaultsRaw: Record<string, unknown> = {};
                for (const [agentType, entry] of Object.entries(normalized)) {
                  if (agentType === "plan" || agentType === "exec" || agentType === "compact") {
                    continue;
                  }
                  legacySubagentDefaultsRaw[agentType] = entry;
                }

                const legacySubagentDefaults =
                  normalizeSubagentAiDefaults(legacySubagentDefaultsRaw);
                result.subagentAiDefaults =
                  Object.keys(legacySubagentDefaults).length > 0
                    ? legacySubagentDefaults
                    : undefined;
              }
            }

            if (input.subagentAiDefaults !== undefined) {
              const normalizedDefaults = normalizeSubagentAiDefaults(input.subagentAiDefaults);
              result.subagentAiDefaults =
                Object.keys(normalizedDefaults).length > 0 ? normalizedDefaults : undefined;

              // Downgrade compatibility: keep agentAiDefaults in sync with legacy subagentAiDefaults.
              // Only mutate keys previously managed by subagentAiDefaults so we don't clobber other
              // agent defaults (e.g., UI-selectable custom agents).
              const previousLegacy = config.subagentAiDefaults ?? {};
              const nextAgentAiDefaults: Record<string, unknown> = {
                ...(result.agentAiDefaults ?? config.agentAiDefaults ?? {}),
              };

              for (const legacyAgentType of Object.keys(previousLegacy)) {
                if (
                  legacyAgentType === "plan" ||
                  legacyAgentType === "exec" ||
                  legacyAgentType === "compact"
                ) {
                  continue;
                }
                if (!(legacyAgentType in normalizedDefaults)) {
                  delete nextAgentAiDefaults[legacyAgentType];
                }
              }

              for (const [agentType, entry] of Object.entries(normalizedDefaults)) {
                if (agentType === "plan" || agentType === "exec" || agentType === "compact")
                  continue;
                nextAgentAiDefaults[agentType] = entry;
              }

              const normalizedAgent = normalizeAgentAiDefaults(nextAgentAiDefaults);
              result.agentAiDefaults =
                Object.keys(normalizedAgent).length > 0 ? normalizedAgent : undefined;
            }

            return result;
          });

          // Re-evaluate task queue in case more slots opened up
          await context.taskService.maybeStartQueuedTasks();
        }),
      unenrollMuxGovernor: t
        .input(schemas.config.unenrollMuxGovernor.input)
        .output(schemas.config.unenrollMuxGovernor.output)
        .handler(async ({ context }) => {
          await context.config.editConfig((config) => {
            const { muxGovernorUrl: _url, muxGovernorToken: _token, ...rest } = config;
            return rest;
          });

          await context.policyService.refreshNow();
        }),
    },
    uiLayouts: {
      getAll: t
        .input(schemas.uiLayouts.getAll.input)
        .output(schemas.uiLayouts.getAll.output)
        .handler(({ context }) => {
          const config = context.config.loadConfigOrDefault();
          return config.layoutPresets ?? DEFAULT_LAYOUT_PRESETS_CONFIG;
        }),
      saveAll: t
        .input(schemas.uiLayouts.saveAll.input)
        .output(schemas.uiLayouts.saveAll.output)
        .handler(async ({ context, input }) => {
          await context.config.editConfig((config) => {
            const normalized = normalizeLayoutPresetsConfig(input.layoutPresets);
            return {
              ...config,
              layoutPresets: isLayoutPresetsConfigEmpty(normalized) ? undefined : normalized,
            };
          });
        }),
    },
    agents: {
      list: t
        .input(schemas.agents.list.input)
        .output(schemas.agents.list.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }

          const { runtime, discoveryPath, metadata } = await resolveAgentDiscoveryContext(
            context,
            input
          );

          // Agents can require a plan file before they're selectable (e.g., orchestrator).
          // Fail closed: if plan state cannot be determined, treat it as missing.
          let planReady = false;
          if (input.workspaceId && metadata) {
            try {
              planReady = await hasNonEmptyPlanFile(
                runtime,
                metadata.name,
                metadata.projectName,
                input.workspaceId
              );
            } catch {
              planReady = false;
            }
          }

          const descriptors = await discoverAgentDefinitions(runtime, discoveryPath);

          const cfg = context.config.loadConfigOrDefault();

          const resolved = await Promise.all(
            descriptors.map(async (descriptor) => {
              try {
                const resolvedFrontmatter = await resolveAgentFrontmatter(
                  runtime,
                  discoveryPath,
                  descriptor.id
                );

                const effectivelyDisabled = isAgentEffectivelyDisabled({
                  cfg,
                  agentId: descriptor.id,
                  resolvedFrontmatter,
                });

                // By default, disabled agents are omitted from discovery so they cannot be
                // selected or cycled in the UI.
                //
                // Settings passes includeDisabled: true so users can opt in/out locally.
                if (effectivelyDisabled && input.includeDisabled !== true) {
                  return null;
                }

                // NOTE: hidden is opt-out. selectable is legacy opt-in.
                const uiSelectableBase =
                  typeof resolvedFrontmatter.ui?.hidden === "boolean"
                    ? !resolvedFrontmatter.ui.hidden
                    : typeof resolvedFrontmatter.ui?.selectable === "boolean"
                      ? resolvedFrontmatter.ui.selectable
                      : true;

                const requiresPlan = resolvedFrontmatter.ui?.requires?.includes("plan") ?? false;
                const uiSelectable = requiresPlan && !planReady ? false : uiSelectableBase;

                return {
                  ...descriptor,
                  name: resolvedFrontmatter.name,
                  description: resolvedFrontmatter.description,
                  uiSelectable,
                  uiColor: resolvedFrontmatter.ui?.color,
                  subagentRunnable: resolvedFrontmatter.subagent?.runnable ?? false,
                  base: resolvedFrontmatter.base,
                  aiDefaults: resolvedFrontmatter.ai,
                  tools: resolvedFrontmatter.tools,
                };
              } catch {
                return descriptor;
              }
            })
          );

          return resolved.filter((descriptor): descriptor is NonNullable<typeof descriptor> =>
            Boolean(descriptor)
          );
        }),
      get: t
        .input(schemas.agents.get.input)
        .output(schemas.agents.get.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          return readAgentDefinition(runtime, discoveryPath, input.agentId);
        }),
    },
    agentSkills: {
      list: t
        .input(schemas.agentSkills.list.input)
        .output(schemas.agentSkills.list.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          return discoverAgentSkills(runtime, discoveryPath);
        }),
      listDiagnostics: t
        .input(schemas.agentSkills.listDiagnostics.input)
        .output(schemas.agentSkills.listDiagnostics.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          return discoverAgentSkillsDiagnostics(runtime, discoveryPath);
        }),
      get: t
        .input(schemas.agentSkills.get.input)
        .output(schemas.agentSkills.get.output)
        .handler(async ({ context, input }) => {
          // Wait for workspace init before agent discovery (SSH may not be ready yet)
          if (input.workspaceId) {
            await context.aiService.waitForInit(input.workspaceId);
          }
          const { runtime, discoveryPath } = await resolveAgentDiscoveryContext(context, input);
          const result = await readAgentSkill(runtime, discoveryPath, input.skillName);
          return result.package;
        }),
    },
    providers: {
      list: t
        .input(schemas.providers.list.input)
        .output(schemas.providers.list.output)
        .handler(({ context }) => context.providerService.list()),
      getConfig: t
        .input(schemas.providers.getConfig.input)
        .output(schemas.providers.getConfig.output)
        .handler(({ context }) => context.providerService.getConfig()),
      setProviderConfig: t
        .input(schemas.providers.setProviderConfig.input)
        .output(schemas.providers.setProviderConfig.output)
        .handler(({ context, input }) =>
          context.providerService.setConfig(input.provider, input.keyPath, input.value)
        ),
      setModels: t
        .input(schemas.providers.setModels.input)
        .output(schemas.providers.setModels.output)
        .handler(({ context, input }) =>
          context.providerService.setModels(input.provider, input.models)
        ),
      onConfigChanged: t
        .input(schemas.providers.onConfigChanged.input)
        .output(schemas.providers.onConfigChanged.output)
        .handler(async function* ({ context, signal }) {
          let resolveNext: (() => void) | null = null;
          let pendingNotification = false;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              // Listener is waiting - wake it up
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              // No listener waiting yet - queue the notification
              pendingNotification = true;
            }
          };

          const unsubscribe = context.providerService.onConfigChanged(push);

          // Consumers often cancel this subscription while there are no pending provider changes.
          // If we block on a never-resolving Promise, AbortSignal cancellation can't unwind the
          // generator, and we leak EventEmitter listeners across tests.
          const onAbort = () => {
            if (ended) return;
            ended = true;
            // Wake up the iterator if it's currently waiting.
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              // If notification arrived before we started waiting, yield immediately
              if (pendingNotification) {
                pendingNotification = false;
                if (ended) break;
                yield undefined;
                continue;
              }

              // Wait for next notification (or abort)
              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });

              if (ended) break;
              yield undefined;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
    },
    policy: {
      get: t
        .input(schemas.policy.get.input)
        .output(schemas.policy.get.output)
        .handler(({ context }) => context.policyService.getPolicyGetResponse()),
      onChanged: t
        .input(schemas.policy.onChanged.input)
        .output(schemas.policy.onChanged.output)
        .handler(async function* ({ context, signal }) {
          let resolveNext: (() => void) | null = null;
          let pendingNotification = false;
          let ended = false;

          const push = () => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          const unsubscribe = context.policyService.onPolicyChanged(push);

          const onAbort = () => {
            if (ended) return;
            ended = true;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve();
            } else {
              pendingNotification = true;
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              if (pendingNotification) {
                pendingNotification = false;
                if (ended) break;
                yield undefined;
                continue;
              }

              await new Promise<void>((resolve) => {
                resolveNext = resolve;
              });

              if (ended) break;
              yield undefined;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      refreshNow: t
        .input(schemas.policy.refreshNow.input)
        .output(schemas.policy.refreshNow.output)
        .handler(async ({ context }) => {
          const result = await context.policyService.refreshNow();
          if (!result.success) {
            return Err(result.error);
          }
          return Ok(context.policyService.getPolicyGetResponse());
        }),
    },
    muxGateway: {
      getAccountStatus: t
        .input(schemas.muxGateway.getAccountStatus.input)
        .output(schemas.muxGateway.getAccountStatus.output)
        .handler(async ({ context }) => {
          const providersConfig = context.config.loadProvidersConfig() ?? {};
          const muxConfig = (providersConfig["mux-gateway"] ?? {}) as Record<string, unknown>;
          const creds = resolveProviderCredentials("mux-gateway", {
            couponCode: typeof muxConfig.couponCode === "string" ? muxConfig.couponCode : undefined,
            voucher: typeof muxConfig.voucher === "string" ? muxConfig.voucher : undefined,
          });

          if (!creds.isConfigured || !creds.couponCode) {
            return Err("Mux Gateway is not logged in");
          }

          let response: Awaited<ReturnType<typeof fetch>>;
          try {
            response = await fetch(`${MUX_GATEWAY_ORIGIN}/api/v1/balance`, {
              headers: {
                Accept: "application/json",
                Authorization: `Bearer ${creds.couponCode}`,
              },
            });
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(`Mux Gateway balance request failed: ${message}`);
          }

          if (response.status === 401) {
            try {
              // Best-effort auto-logout: clear local mux-gateway creds on session expiry.
              context.providerService.setConfig("mux-gateway", ["couponCode"], "");
              context.providerService.setConfig("mux-gateway", ["voucher"], "");
            } catch {
              // Ignore failures clearing local credentials
            }

            return Err(MUX_GATEWAY_SESSION_EXPIRED_MESSAGE);
          }

          if (!response.ok) {
            let body = "";
            try {
              body = await response.text();
            } catch {
              // Ignore errors reading response body
            }
            const prefix = body.trim().slice(0, 200);
            return Err(
              `Mux Gateway balance request failed (HTTP ${response.status}): ${
                prefix || response.statusText
              }`
            );
          }

          let json: unknown;
          try {
            json = await response.json();
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(`Mux Gateway balance response was not valid JSON: ${message}`);
          }

          const payload = json as {
            remaining_microdollars?: unknown;
            ai_gateway_concurrent_requests_per_user?: unknown;
          };

          const remaining = payload.remaining_microdollars;
          const concurrency = payload.ai_gateway_concurrent_requests_per_user;

          if (
            typeof remaining !== "number" ||
            !Number.isFinite(remaining) ||
            !Number.isInteger(remaining) ||
            remaining < 0 ||
            typeof concurrency !== "number" ||
            !Number.isFinite(concurrency) ||
            !Number.isInteger(concurrency) ||
            concurrency < 0
          ) {
            return Err("Mux Gateway returned an invalid balance payload");
          }

          return Ok({
            remaining_microdollars: remaining,
            ai_gateway_concurrent_requests_per_user: concurrency,
          });
        }),
    },

    muxGatewayOauth: {
      startDesktopFlow: t
        .input(schemas.muxGatewayOauth.startDesktopFlow.input)
        .output(schemas.muxGatewayOauth.startDesktopFlow.output)
        .handler(({ context }) => {
          return context.muxGatewayOauthService.startDesktopFlow();
        }),
      waitForDesktopFlow: t
        .input(schemas.muxGatewayOauth.waitForDesktopFlow.input)
        .output(schemas.muxGatewayOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGatewayOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.muxGatewayOauth.cancelDesktopFlow.input)
        .output(schemas.muxGatewayOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.muxGatewayOauthService.cancelDesktopFlow(input.flowId);
        }),
    },
    copilotOauth: {
      startDeviceFlow: t
        .input(schemas.copilotOauth.startDeviceFlow.input)
        .output(schemas.copilotOauth.startDeviceFlow.output)
        .handler(({ context }) => {
          return context.copilotOauthService.startDeviceFlow();
        }),
      waitForDeviceFlow: t
        .input(schemas.copilotOauth.waitForDeviceFlow.input)
        .output(schemas.copilotOauth.waitForDeviceFlow.output)
        .handler(({ context, input }) => {
          return context.copilotOauthService.waitForDeviceFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDeviceFlow: t
        .input(schemas.copilotOauth.cancelDeviceFlow.input)
        .output(schemas.copilotOauth.cancelDeviceFlow.output)
        .handler(({ context, input }) => {
          context.copilotOauthService.cancelDeviceFlow(input.flowId);
        }),
    },
    muxGovernorOauth: {
      startDesktopFlow: t
        .input(schemas.muxGovernorOauth.startDesktopFlow.input)
        .output(schemas.muxGovernorOauth.startDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGovernorOauthService.startDesktopFlow({
            governorOrigin: input.governorOrigin,
          });
        }),
      waitForDesktopFlow: t
        .input(schemas.muxGovernorOauth.waitForDesktopFlow.input)
        .output(schemas.muxGovernorOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.muxGovernorOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.muxGovernorOauth.cancelDesktopFlow.input)
        .output(schemas.muxGovernorOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.muxGovernorOauthService.cancelDesktopFlow(input.flowId);
        }),
    },
    codexOauth: {
      startDesktopFlow: t
        .input(schemas.codexOauth.startDesktopFlow.input)
        .output(schemas.codexOauth.startDesktopFlow.output)
        .handler(({ context }) => {
          return context.codexOauthService.startDesktopFlow();
        }),
      waitForDesktopFlow: t
        .input(schemas.codexOauth.waitForDesktopFlow.input)
        .output(schemas.codexOauth.waitForDesktopFlow.output)
        .handler(({ context, input }) => {
          return context.codexOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.codexOauth.cancelDesktopFlow.input)
        .output(schemas.codexOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.codexOauthService.cancelDesktopFlow(input.flowId);
        }),
      startDeviceFlow: t
        .input(schemas.codexOauth.startDeviceFlow.input)
        .output(schemas.codexOauth.startDeviceFlow.output)
        .handler(({ context }) => {
          return context.codexOauthService.startDeviceFlow();
        }),
      waitForDeviceFlow: t
        .input(schemas.codexOauth.waitForDeviceFlow.input)
        .output(schemas.codexOauth.waitForDeviceFlow.output)
        .handler(({ context, input }) => {
          return context.codexOauthService.waitForDeviceFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDeviceFlow: t
        .input(schemas.codexOauth.cancelDeviceFlow.input)
        .output(schemas.codexOauth.cancelDeviceFlow.output)
        .handler(async ({ context, input }) => {
          await context.codexOauthService.cancelDeviceFlow(input.flowId);
        }),
      disconnect: t
        .input(schemas.codexOauth.disconnect.input)
        .output(schemas.codexOauth.disconnect.output)
        .handler(({ context }) => {
          return context.codexOauthService.disconnect();
        }),
    },
    general: {
      listDirectory: t
        .input(schemas.general.listDirectory.input)
        .output(schemas.general.listDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listDirectory(input.path);
        }),
      createDirectory: t
        .input(schemas.general.createDirectory.input)
        .output(schemas.general.createDirectory.output)
        .handler(async ({ context, input }) => {
          return context.projectService.createDirectory(input.path);
        }),
      ping: t
        .input(schemas.general.ping.input)
        .output(schemas.general.ping.output)
        .handler(({ input }) => {
          return `Pong: ${input}`;
        }),
      tick: t
        .input(schemas.general.tick.input)
        .output(schemas.general.tick.output)
        .handler(async function* ({ input }) {
          for (let i = 1; i <= input.count; i++) {
            yield { tick: i, timestamp: Date.now() };
            if (i < input.count) {
              await new Promise((r) => setTimeout(r, input.intervalMs));
            }
          }
        }),
      getLogPath: t
        .input(schemas.general.getLogPath.input)
        .output(schemas.general.getLogPath.output)
        .handler(() => {
          return { path: getLogFilePath() };
        }),
      clearLogs: t
        .input(schemas.general.clearLogs.input)
        .output(schemas.general.clearLogs.output)
        .handler(async () => {
          try {
            await clearLogFiles();
            clearLogEntries();
            return { success: true };
          } catch (err) {
            const message = getErrorMessage(err);
            return { success: false, error: message };
          }
        }),
      subscribeLogs: t
        .input(schemas.general.subscribeLogs.input)
        .output(schemas.general.subscribeLogs.output)
        .handler(async function* ({ input, signal }) {
          const LOG_LEVEL_PRIORITY: Record<LogEntry["level"], number> = {
            error: 0,
            warn: 1,
            info: 2,
            debug: 3,
          };

          function shouldInclude(
            entryLevel: LogEntry["level"],
            minLevel: LogEntry["level"]
          ): boolean {
            return (
              (LOG_LEVEL_PRIORITY[entryLevel] ?? LOG_LEVEL_PRIORITY.debug) <=
              (LOG_LEVEL_PRIORITY[minLevel] ?? LOG_LEVEL_PRIORITY.info)
            );
          }

          const minLevel = input.level ?? "info";

          const queue = createAsyncMessageQueue<
            | { type: "snapshot"; epoch: number; entries: LogEntry[] }
            | { type: "append"; epoch: number; entries: LogEntry[] }
            | { type: "reset"; epoch: number }
          >();

          // Atomic handshake: register listener + snapshot in one step.
          // No events can be lost between snapshot and subscription.
          const { snapshot, unsubscribe } = subscribeLogFeed((event) => {
            if (signal?.aborted) {
              return;
            }

            if (event.type === "append") {
              if (shouldInclude(event.entry.level, minLevel)) {
                queue.push({ type: "append", epoch: event.epoch, entries: [event.entry] });
              }
              return;
            }

            queue.push({ type: "reset", epoch: event.epoch });
          }, minLevel);

          queue.push({
            type: "snapshot",
            epoch: snapshot.epoch,
            entries: snapshot.entries.filter((e) => shouldInclude(e.level, minLevel)),
          });

          const onAbort = () => {
            queue.end();
          };
          signal?.addEventListener("abort", onAbort);

          try {
            yield* queue.iterate();
          } finally {
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
            queue.end();
          }
        }),
      openInEditor: t
        .input(schemas.general.openInEditor.input)
        .output(schemas.general.openInEditor.output)
        .handler(async ({ context, input }) => {
          return context.editorService.openInEditor(
            input.workspaceId,
            input.targetPath,
            input.editorConfig
          );
        }),
    },
    secrets: {
      get: t
        .input(schemas.secrets.get.input)
        .output(schemas.secrets.get.output)
        .handler(({ context, input }) => {
          const projectPath =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0
              ? input.projectPath
              : undefined;

          return projectPath
            ? context.config.getProjectSecrets(projectPath)
            : context.config.getGlobalSecrets();
        }),
      update: t
        .input(schemas.secrets.update.input)
        .output(schemas.secrets.update.output)
        .handler(async ({ context, input }) => {
          const projectPath =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0
              ? input.projectPath
              : undefined;

          try {
            if (projectPath) {
              await context.config.updateProjectSecrets(projectPath, input.secrets);
            } else {
              await context.config.updateGlobalSecrets(input.secrets);
            }

            return Ok(undefined);
          } catch (error) {
            const message = getErrorMessage(error);
            return Err(message);
          }
        }),
    },
    mcp: {
      list: t
        .input(schemas.mcp.list.input)
        .output(schemas.mcp.list.output)
        .handler(async ({ context, input }) => {
          const servers = await context.mcpConfigService.listServers(input.projectPath);

          if (!context.policyService.isEnforced()) {
            return servers;
          }

          const filtered: typeof servers = {};
          for (const [name, info] of Object.entries(servers)) {
            if (context.policyService.isMcpTransportAllowed(info.transport)) {
              filtered[name] = info;
            }
          }

          return filtered;
        }),
      add: t
        .input(schemas.mcp.add.input)
        .output(schemas.mcp.add.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const existingServer = existing[input.name];

          const transport = input.transport ?? "stdio";
          if (context.policyService.isEnforced()) {
            if (!context.policyService.isMcpTransportAllowed(transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const hasHeaders = Boolean(input.headers && Object.keys(input.headers).length > 0);
          const usesSecretHeaders = Boolean(
            input.headers &&
            Object.values(input.headers).some(
              (v) => typeof v === "object" && v !== null && "secret" in v
            )
          );

          const action = (() => {
            if (!existingServer) {
              return "add";
            }

            if (
              existingServer.transport !== "stdio" &&
              transport !== "stdio" &&
              existingServer.transport === transport &&
              existingServer.url === input.url &&
              JSON.stringify(existingServer.headers ?? {}) !== JSON.stringify(input.headers ?? {})
            ) {
              return "set_headers";
            }

            return "edit";
          })();

          const result = await context.mcpConfigService.addServer(input.name, {
            transport,
            command: input.command,
            url: input.url,
            headers: input.headers,
          });

          if (result.success) {
            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action,
                transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      remove: t
        .input(schemas.mcp.remove.input)
        .output(schemas.mcp.remove.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.removeServer(input.name);

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: "remove",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      test: t
        .input(schemas.mcp.test.input)
        .output(schemas.mcp.test.output)
        .handler(async ({ context, input }) => {
          const start = Date.now();

          const projectPathProvided =
            typeof input.projectPath === "string" && input.projectPath.trim().length > 0;
          const resolvedProjectPath = projectPathProvided
            ? input.projectPath!
            : context.config.rootDir;

          const secrets = secretsToRecord(
            projectPathProvided
              ? context.config.getEffectiveSecrets(resolvedProjectPath)
              : context.config.getGlobalSecrets()
          );

          const configuredTransport = input.name
            ? (
                await context.mcpConfigService.listServers(
                  projectPathProvided ? resolvedProjectPath : undefined
                )
              )[input.name]?.transport
            : undefined;

          const transport =
            configuredTransport ?? (input.command ? "stdio" : (input.transport ?? "auto"));

          if (context.policyService.isEnforced()) {
            if (!context.policyService.isMcpTransportAllowed(transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpServerManager.test({
            projectPath: resolvedProjectPath,
            name: input.name,
            command: input.command,
            transport: input.transport,
            url: input.url,
            headers: input.headers,
            projectSecrets: secrets,
          });

          const durationMs = Date.now() - start;

          const categorizeError = (
            error: string
          ): "timeout" | "connect" | "http_status" | "unknown" => {
            const lower = error.toLowerCase();
            if (lower.includes("timed out")) {
              return "timeout";
            }
            if (
              lower.includes("econnrefused") ||
              lower.includes("econnreset") ||
              lower.includes("enotfound") ||
              lower.includes("ehostunreach")
            ) {
              return "connect";
            }
            if (/\b(400|401|403|404|405|500|502|503)\b/.test(lower)) {
              return "http_status";
            }
            return "unknown";
          };

          context.telemetryService.capture({
            event: "mcp_server_tested",
            properties: {
              transport,
              success: result.success,
              duration_ms_b2: roundToBase2(durationMs),
              ...(result.success ? {} : { error_category: categorizeError(result.error) }),
            },
          });

          return result;
        }),
      setEnabled: t
        .input(schemas.mcp.setEnabled.input)
        .output(schemas.mcp.setEnabled.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.setServerEnabled(input.name, input.enabled);

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: input.enabled ? "enable" : "disable",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
              },
            });
          }

          return result;
        }),
      setToolAllowlist: t
        .input(schemas.mcp.setToolAllowlist.input)
        .output(schemas.mcp.setToolAllowlist.output)
        .handler(async ({ context, input }) => {
          const existing = await context.mcpConfigService.listServers();
          const server = existing[input.name];

          if (context.policyService.isEnforced() && server) {
            if (!context.policyService.isMcpTransportAllowed(server.transport)) {
              return { success: false, error: "MCP transport is disabled by policy" };
            }
          }

          const result = await context.mcpConfigService.setToolAllowlist(
            input.name,
            input.toolAllowlist
          );

          if (result.success && server) {
            const hasHeaders =
              server.transport !== "stdio" &&
              Boolean(server.headers && Object.keys(server.headers).length > 0);
            const usesSecretHeaders =
              server.transport !== "stdio" &&
              Boolean(
                server.headers &&
                Object.values(server.headers).some(
                  (v) => typeof v === "object" && v !== null && "secret" in v
                )
              );

            context.telemetryService.capture({
              event: "mcp_server_config_changed",
              properties: {
                action: "set_tool_allowlist",
                transport: server.transport,
                has_headers: hasHeaders,
                uses_secret_headers: usesSecretHeaders,
                tool_allowlist_size_b2: roundToBase2(input.toolAllowlist.length),
              },
            });
          }

          return result;
        }),
    },
    mcpOauth: {
      startDesktopFlow: t
        .input(schemas.mcpOauth.startDesktopFlow.input)
        .output(schemas.mcpOauth.startDesktopFlow.output)
        .handler(async ({ context, input }) => {
          // Global MCP settings can start OAuth without selecting a project.
          // Use mux home as a stable fallback so existing flow codepaths remain unchanged.
          const projectPath = input.projectPath ?? context.config.rootDir;

          return context.mcpOauthService.startDesktopFlow({ ...input, projectPath });
        }),
      waitForDesktopFlow: t
        .input(schemas.mcpOauth.waitForDesktopFlow.input)
        .output(schemas.mcpOauth.waitForDesktopFlow.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.waitForDesktopFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelDesktopFlow: t
        .input(schemas.mcpOauth.cancelDesktopFlow.input)
        .output(schemas.mcpOauth.cancelDesktopFlow.output)
        .handler(async ({ context, input }) => {
          await context.mcpOauthService.cancelDesktopFlow(input.flowId);
        }),
      startServerFlow: t
        .input(schemas.mcpOauth.startServerFlow.input)
        .output(schemas.mcpOauth.startServerFlow.output)
        .handler(async ({ context, input }) => {
          // Global MCP settings can start OAuth without selecting a project.
          // Use mux home as a stable fallback so existing flow codepaths remain unchanged.
          const projectPath = input.projectPath ?? context.config.rootDir;

          const headers = context.headers;

          const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
          if (origin) {
            try {
              const redirectUri = new URL("/auth/mcp-oauth/callback", origin).toString();
              return context.mcpOauthService.startServerFlow({
                ...input,
                projectPath,
                redirectUri,
              });
            } catch {
              // Fall back to Host header.
            }
          }

          const hostHeader = headers?.["x-forwarded-host"] ?? headers?.host;
          const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]?.trim() : "";
          if (!host) {
            return Err("Missing Host header");
          }

          const protoHeader = headers?.["x-forwarded-proto"];
          const forwardedProto =
            typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
          const proto = forwardedProto.length ? forwardedProto : "http";

          const redirectUri = `${proto}://${host}/auth/mcp-oauth/callback`;

          return context.mcpOauthService.startServerFlow({
            ...input,
            projectPath,
            redirectUri,
          });
        }),
      waitForServerFlow: t
        .input(schemas.mcpOauth.waitForServerFlow.input)
        .output(schemas.mcpOauth.waitForServerFlow.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.waitForServerFlow(input.flowId, {
            timeoutMs: input.timeoutMs,
          });
        }),
      cancelServerFlow: t
        .input(schemas.mcpOauth.cancelServerFlow.input)
        .output(schemas.mcpOauth.cancelServerFlow.output)
        .handler(async ({ context, input }) => {
          await context.mcpOauthService.cancelServerFlow(input.flowId);
        }),
      getAuthStatus: t
        .input(schemas.mcpOauth.getAuthStatus.input)
        .output(schemas.mcpOauth.getAuthStatus.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.getAuthStatus({ serverUrl: input.serverUrl });
        }),
      logout: t
        .input(schemas.mcpOauth.logout.input)
        .output(schemas.mcpOauth.logout.output)
        .handler(async ({ context, input }) => {
          return context.mcpOauthService.logout({ serverUrl: input.serverUrl });
        }),
    },
    projects: {
      list: t
        .input(schemas.projects.list.input)
        .output(schemas.projects.list.output)
        .handler(({ context }) => {
          return context.projectService.list();
        }),
      create: t
        .input(schemas.projects.create.input)
        .output(schemas.projects.create.output)
        .handler(async ({ context, input }) => {
          return context.projectService.create(input.projectPath);
        }),
      getDefaultProjectDir: t
        .input(schemas.projects.getDefaultProjectDir.input)
        .output(schemas.projects.getDefaultProjectDir.output)
        .handler(({ context }) => {
          return context.projectService.getDefaultProjectDir();
        }),
      setDefaultProjectDir: t
        .input(schemas.projects.setDefaultProjectDir.input)
        .output(schemas.projects.setDefaultProjectDir.output)
        .handler(async ({ context, input }) => {
          await context.projectService.setDefaultProjectDir(input.path);
        }),
      clone: t
        .input(schemas.projects.clone.input)
        .output(schemas.projects.clone.output)
        .handler(async function* ({ context, input, signal }) {
          yield* context.projectService.cloneWithProgress(input, signal);
        }),
      pickDirectory: t
        .input(schemas.projects.pickDirectory.input)
        .output(schemas.projects.pickDirectory.output)
        .handler(async ({ context }) => {
          return context.projectService.pickDirectory();
        }),
      getFileCompletions: t
        .input(schemas.projects.getFileCompletions.input)
        .output(schemas.projects.getFileCompletions.output)
        .handler(async ({ context, input }) => {
          return context.projectService.getFileCompletions(
            input.projectPath,
            input.query,
            input.limit
          );
        }),
      runtimeAvailability: t
        .input(schemas.projects.runtimeAvailability.input)
        .output(schemas.projects.runtimeAvailability.output)
        .handler(async ({ input }) => {
          return checkRuntimeAvailability(input.projectPath);
        }),
      listBranches: t
        .input(schemas.projects.listBranches.input)
        .output(schemas.projects.listBranches.output)
        .handler(async ({ context, input }) => {
          return context.projectService.listBranches(input.projectPath);
        }),
      gitInit: t
        .input(schemas.projects.gitInit.input)
        .output(schemas.projects.gitInit.output)
        .handler(async ({ context, input }) => {
          return context.projectService.gitInit(input.projectPath);
        }),
      remove: t
        .input(schemas.projects.remove.input)
        .output(schemas.projects.remove.output)
        .handler(async ({ context, input }) => {
          return context.projectService.remove(input.projectPath);
        }),
      secrets: {
        get: t
          .input(schemas.projects.secrets.get.input)
          .output(schemas.projects.secrets.get.output)
          .handler(({ context, input }) => {
            return context.projectService.getSecrets(input.projectPath);
          }),
        update: t
          .input(schemas.projects.secrets.update.input)
          .output(schemas.projects.secrets.update.output)
          .handler(async ({ context, input }) => {
            return context.projectService.updateSecrets(input.projectPath, input.secrets);
          }),
      },
      mcp: {
        list: t
          .input(schemas.projects.mcp.list.input)
          .output(schemas.projects.mcp.list.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(input.projectPath);

            if (!context.policyService.isEnforced()) {
              return servers;
            }

            const filtered: typeof servers = {};
            for (const [name, info] of Object.entries(servers)) {
              if (context.policyService.isMcpTransportAllowed(info.transport)) {
                filtered[name] = info;
              }
            }

            return filtered;
          }),
        add: t
          .input(schemas.projects.mcp.add.input)
          .output(schemas.projects.mcp.add.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const existingServer = existing[input.name];

            const transport = input.transport ?? "stdio";
            if (context.policyService.isEnforced()) {
              if (!context.policyService.isMcpTransportAllowed(transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }
            const hasHeaders = Boolean(input.headers && Object.keys(input.headers).length > 0);
            const usesSecretHeaders = Boolean(
              input.headers &&
              Object.values(input.headers).some(
                (v) => typeof v === "object" && v !== null && "secret" in v
              )
            );

            const action = (() => {
              if (!existingServer) {
                return "add";
              }

              if (
                existingServer.transport !== "stdio" &&
                transport !== "stdio" &&
                existingServer.transport === transport &&
                existingServer.url === input.url &&
                JSON.stringify(existingServer.headers ?? {}) !== JSON.stringify(input.headers ?? {})
              ) {
                return "set_headers";
              }

              return "edit";
            })();

            const result = await context.mcpConfigService.addServer(input.name, {
              transport,
              command: input.command,
              url: input.url,
              headers: input.headers,
            });

            if (result.success) {
              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action,
                  transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        remove: t
          .input(schemas.projects.mcp.remove.input)
          .output(schemas.projects.mcp.remove.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.removeServer(input.name);

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: "remove",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        test: t
          .input(schemas.projects.mcp.test.input)
          .output(schemas.projects.mcp.test.output)
          .handler(async ({ context, input }) => {
            const start = Date.now();
            const secrets = secretsToRecord(context.config.getEffectiveSecrets(input.projectPath));

            const configuredTransport = input.name
              ? (await context.mcpConfigService.listServers(input.projectPath))[input.name]
                  ?.transport
              : undefined;

            const transport =
              configuredTransport ?? (input.command ? "stdio" : (input.transport ?? "auto"));

            if (context.policyService.isEnforced()) {
              if (!context.policyService.isMcpTransportAllowed(transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpServerManager.test({
              projectPath: input.projectPath,
              name: input.name,
              command: input.command,
              transport: input.transport,
              url: input.url,
              headers: input.headers,
              projectSecrets: secrets,
            });

            const durationMs = Date.now() - start;

            const categorizeError = (
              error: string
            ): "timeout" | "connect" | "http_status" | "unknown" => {
              const lower = error.toLowerCase();
              if (lower.includes("timed out")) {
                return "timeout";
              }
              if (
                lower.includes("econnrefused") ||
                lower.includes("econnreset") ||
                lower.includes("enotfound") ||
                lower.includes("ehostunreach")
              ) {
                return "connect";
              }
              if (/\b(400|401|403|404|405|500|502|503)\b/.test(lower)) {
                return "http_status";
              }
              return "unknown";
            };

            context.telemetryService.capture({
              event: "mcp_server_tested",
              properties: {
                transport,
                success: result.success,
                duration_ms_b2: roundToBase2(durationMs),
                ...(result.success ? {} : { error_category: categorizeError(result.error) }),
              },
            });

            return result;
          }),
        setEnabled: t
          .input(schemas.projects.mcp.setEnabled.input)
          .output(schemas.projects.mcp.setEnabled.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.setServerEnabled(
              input.name,
              input.enabled
            );

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: input.enabled ? "enable" : "disable",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                },
              });
            }

            return result;
          }),
        setToolAllowlist: t
          .input(schemas.projects.mcp.setToolAllowlist.input)
          .output(schemas.projects.mcp.setToolAllowlist.output)
          .handler(async ({ context, input }) => {
            const existing = await context.mcpConfigService.listServers();
            const server = existing[input.name];

            if (context.policyService.isEnforced() && server) {
              if (!context.policyService.isMcpTransportAllowed(server.transport)) {
                return { success: false, error: "MCP transport is disabled by policy" };
              }
            }

            const result = await context.mcpConfigService.setToolAllowlist(
              input.name,
              input.toolAllowlist
            );

            if (result.success && server) {
              const hasHeaders =
                server.transport !== "stdio" &&
                Boolean(server.headers && Object.keys(server.headers).length > 0);
              const usesSecretHeaders =
                server.transport !== "stdio" &&
                Boolean(
                  server.headers &&
                  Object.values(server.headers).some(
                    (v) => typeof v === "object" && v !== null && "secret" in v
                  )
                );

              context.telemetryService.capture({
                event: "mcp_server_config_changed",
                properties: {
                  action: "set_tool_allowlist",
                  transport: server.transport,
                  has_headers: hasHeaders,
                  uses_secret_headers: usesSecretHeaders,
                  tool_allowlist_size_b2: roundToBase2(input.toolAllowlist.length),
                },
              });
            }

            return result;
          }),
      },
      mcpOauth: {
        startDesktopFlow: t
          .input(schemas.projects.mcpOauth.startDesktopFlow.input)
          .output(schemas.projects.mcpOauth.startDesktopFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.startDesktopFlow(input);
          }),
        waitForDesktopFlow: t
          .input(schemas.projects.mcpOauth.waitForDesktopFlow.input)
          .output(schemas.projects.mcpOauth.waitForDesktopFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.waitForDesktopFlow(input.flowId, {
              timeoutMs: input.timeoutMs,
            });
          }),
        cancelDesktopFlow: t
          .input(schemas.projects.mcpOauth.cancelDesktopFlow.input)
          .output(schemas.projects.mcpOauth.cancelDesktopFlow.output)
          .handler(async ({ context, input }) => {
            await context.mcpOauthService.cancelDesktopFlow(input.flowId);
          }),
        startServerFlow: t
          .input(schemas.projects.mcpOauth.startServerFlow.input)
          .output(schemas.projects.mcpOauth.startServerFlow.output)
          .handler(async ({ context, input }) => {
            const headers = context.headers;

            const origin = typeof headers?.origin === "string" ? headers.origin.trim() : "";
            if (origin) {
              try {
                const redirectUri = new URL("/auth/mcp-oauth/callback", origin).toString();
                return context.mcpOauthService.startServerFlow({ ...input, redirectUri });
              } catch {
                // Fall back to Host header.
              }
            }

            const hostHeader = headers?.["x-forwarded-host"] ?? headers?.host;
            const host = typeof hostHeader === "string" ? hostHeader.split(",")[0]?.trim() : "";
            if (!host) {
              return Err("Missing Host header");
            }

            const protoHeader = headers?.["x-forwarded-proto"];
            const forwardedProto =
              typeof protoHeader === "string" ? protoHeader.split(",")[0]?.trim() : "";
            const proto = forwardedProto.length ? forwardedProto : "http";

            const redirectUri = `${proto}://${host}/auth/mcp-oauth/callback`;

            return context.mcpOauthService.startServerFlow({ ...input, redirectUri });
          }),
        waitForServerFlow: t
          .input(schemas.projects.mcpOauth.waitForServerFlow.input)
          .output(schemas.projects.mcpOauth.waitForServerFlow.output)
          .handler(async ({ context, input }) => {
            return context.mcpOauthService.waitForServerFlow(input.flowId, {
              timeoutMs: input.timeoutMs,
            });
          }),
        cancelServerFlow: t
          .input(schemas.projects.mcpOauth.cancelServerFlow.input)
          .output(schemas.projects.mcpOauth.cancelServerFlow.output)
          .handler(async ({ context, input }) => {
            await context.mcpOauthService.cancelServerFlow(input.flowId);
          }),
        getAuthStatus: t
          .input(schemas.projects.mcpOauth.getAuthStatus.input)
          .output(schemas.projects.mcpOauth.getAuthStatus.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(input.projectPath);
            const server = servers[input.serverName];

            if (!server || server.transport === "stdio") {
              return { isLoggedIn: false, hasRefreshToken: false };
            }

            return context.mcpOauthService.getAuthStatus({ serverUrl: server.url });
          }),
        logout: t
          .input(schemas.projects.mcpOauth.logout.input)
          .output(schemas.projects.mcpOauth.logout.output)
          .handler(async ({ context, input }) => {
            const servers = await context.mcpConfigService.listServers(input.projectPath);
            const server = servers[input.serverName];

            if (!server || server.transport === "stdio") {
              return Ok(undefined);
            }

            return context.mcpOauthService.logout({ serverUrl: server.url });
          }),
      },
      idleCompaction: {
        get: t
          .input(schemas.projects.idleCompaction.get.input)
          .output(schemas.projects.idleCompaction.get.output)
          .handler(({ context, input }) => ({
            hours: context.projectService.getIdleCompactionHours(input.projectPath),
          })),
        set: t
          .input(schemas.projects.idleCompaction.set.input)
          .output(schemas.projects.idleCompaction.set.output)
          .handler(({ context, input }) =>
            context.projectService.setIdleCompactionHours(input.projectPath, input.hours)
          ),
      },
      sections: {
        list: t
          .input(schemas.projects.sections.list.input)
          .output(schemas.projects.sections.list.output)
          .handler(({ context, input }) => context.projectService.listSections(input.projectPath)),
        create: t
          .input(schemas.projects.sections.create.input)
          .output(schemas.projects.sections.create.output)
          .handler(({ context, input }) =>
            context.projectService.createSection(input.projectPath, input.name, input.color)
          ),
        update: t
          .input(schemas.projects.sections.update.input)
          .output(schemas.projects.sections.update.output)
          .handler(({ context, input }) =>
            context.projectService.updateSection(input.projectPath, input.sectionId, {
              name: input.name,
              color: input.color,
            })
          ),
        remove: t
          .input(schemas.projects.sections.remove.input)
          .output(schemas.projects.sections.remove.output)
          .handler(({ context, input }) =>
            context.projectService.removeSection(input.projectPath, input.sectionId)
          ),
        reorder: t
          .input(schemas.projects.sections.reorder.input)
          .output(schemas.projects.sections.reorder.output)
          .handler(({ context, input }) =>
            context.projectService.reorderSections(input.projectPath, input.sectionIds)
          ),
        assignWorkspace: t
          .input(schemas.projects.sections.assignWorkspace.input)
          .output(schemas.projects.sections.assignWorkspace.output)
          .handler(async ({ context, input }) => {
            const result = await context.projectService.assignWorkspaceToSection(
              input.projectPath,
              input.workspaceId,
              input.sectionId
            );
            if (result.success) {
              // Emit metadata update so frontend receives the sectionId change
              await context.workspaceService.refreshAndEmitMetadata(input.workspaceId);
            }
            return result;
          }),
      },
    },
    nameGeneration: {
      generate: t
        .input(schemas.nameGeneration.generate.input)
        .output(schemas.nameGeneration.generate.output)
        .handler(async ({ context, input }) => {
          // Frontend provides ordered candidate list; gateway routing resolved by createModel.
          // Backend tries candidates in order with retry on API errors.
          const result = await generateWorkspaceIdentity(
            input.message,
            input.candidates,
            context.aiService
          );
          if (!result.success) {
            return result;
          }
          return {
            success: true,
            data: {
              name: result.data.name,
              title: result.data.title,
              modelUsed: result.data.modelUsed,
            },
          };
        }),
    },
    coder: {
      getInfo: t
        .input(schemas.coder.getInfo.input)
        .output(schemas.coder.getInfo.output)
        .handler(async ({ context }) => {
          return context.coderService.getCoderInfo();
        }),
      listTemplates: t
        .input(schemas.coder.listTemplates.input)
        .output(schemas.coder.listTemplates.output)
        .handler(async ({ context }) => {
          return context.coderService.listTemplates();
        }),
      listPresets: t
        .input(schemas.coder.listPresets.input)
        .output(schemas.coder.listPresets.output)
        .handler(async ({ context, input }) => {
          return context.coderService.listPresets(input.template, input.org);
        }),
      listWorkspaces: t
        .input(schemas.coder.listWorkspaces.input)
        .output(schemas.coder.listWorkspaces.output)
        .handler(async ({ context }) => {
          return context.coderService.listWorkspaces();
        }),
    },
    workspace: {
      list: t
        .input(schemas.workspace.list.input)
        .output(schemas.workspace.list.output)
        .handler(async ({ context, input }) => {
          const allWorkspaces = await context.workspaceService.list();
          // Filter by archived status (derived from timestamps via shared utility)
          if (input?.archived) {
            return allWorkspaces.filter((w) => isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
          }
          // Default: return non-archived workspaces
          return allWorkspaces.filter((w) => !isWorkspaceArchived(w.archivedAt, w.unarchivedAt));
        }),
      create: t
        .input(schemas.workspace.create.input)
        .output(schemas.workspace.create.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.create(
            input.projectPath,
            input.branchName,
            input.trunkBranch,
            input.title,
            input.runtimeConfig,
            input.sectionId
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, metadata: result.data.metadata };
        }),
      remove: t
        .input(schemas.workspace.remove.input)
        .output(schemas.workspace.remove.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.remove(
            input.workspaceId,
            input.options?.force
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true };
        }),
      updateAgentAISettings: t
        .input(schemas.workspace.updateAgentAISettings.input)
        .output(schemas.workspace.updateAgentAISettings.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateAgentAISettings(
            input.workspaceId,
            input.agentId,
            input.aiSettings
          );
        }),
      rename: t
        .input(schemas.workspace.rename.input)
        .output(schemas.workspace.rename.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.rename(input.workspaceId, input.newName);
        }),
      updateModeAISettings: t
        .input(schemas.workspace.updateModeAISettings.input)
        .output(schemas.workspace.updateModeAISettings.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateModeAISettings(
            input.workspaceId,
            input.mode,
            input.aiSettings
          );
        }),
      updateTitle: t
        .input(schemas.workspace.updateTitle.input)
        .output(schemas.workspace.updateTitle.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.updateTitle(input.workspaceId, input.title);
        }),
      regenerateTitle: t
        .input(schemas.workspace.regenerateTitle.input)
        .output(schemas.workspace.regenerateTitle.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.regenerateTitle(input.workspaceId);
        }),
      archive: t
        .input(schemas.workspace.archive.input)
        .output(schemas.workspace.archive.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.archive(input.workspaceId);
        }),
      unarchive: t
        .input(schemas.workspace.unarchive.input)
        .output(schemas.workspace.unarchive.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.unarchive(input.workspaceId);
        }),
      archiveMergedInProject: t
        .input(schemas.workspace.archiveMergedInProject.input)
        .output(schemas.workspace.archiveMergedInProject.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.archiveMergedInProject(input.projectPath);
        }),
      fork: t
        .input(schemas.workspace.fork.input)
        .output(schemas.workspace.fork.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.fork(
            input.sourceWorkspaceId,
            input.newName
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return {
            success: true,
            metadata: result.data.metadata,
            projectPath: result.data.projectPath,
          };
        }),
      sendMessage: t
        .input(schemas.workspace.sendMessage.input)
        .output(schemas.workspace.sendMessage.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.sendMessage(
            input.workspaceId,
            input.message,
            input.options
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: {} };
        }),
      answerAskUserQuestion: t
        .input(schemas.workspace.answerAskUserQuestion.input)
        .output(schemas.workspace.answerAskUserQuestion.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.answerAskUserQuestion(
            input.workspaceId,
            input.toolCallId,
            input.answers
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: undefined };
        }),
      answerDelegatedToolCall: t
        .input(schemas.workspace.answerDelegatedToolCall.input)
        .output(schemas.workspace.answerDelegatedToolCall.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.answerDelegatedToolCall(
            input.workspaceId,
            input.toolCallId,
            input.result
          );

          if (!result.success) {
            return { success: false, error: result.error };
          }

          return { success: true, data: undefined };
        }),
      resumeStream: t
        .input(schemas.workspace.resumeStream.input)
        .output(schemas.workspace.resumeStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.resumeStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            const error =
              typeof result.error === "string"
                ? { type: "unknown" as const, raw: result.error }
                : result.error;
            return { success: false, error };
          }
          return { success: true, data: result.data };
        }),
      setAutoRetryEnabled: t
        .input(schemas.workspace.setAutoRetryEnabled.input)
        .output(schemas.workspace.setAutoRetryEnabled.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.setAutoRetryEnabled(
            input.workspaceId,
            input.enabled,
            input.persist ?? true
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      getStartupAutoRetryModel: t
        .input(schemas.workspace.getStartupAutoRetryModel.input)
        .output(schemas.workspace.getStartupAutoRetryModel.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.getStartupAutoRetryModel(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      setAutoCompactionThreshold: t
        .input(schemas.workspace.setAutoCompactionThreshold.input)
        .output(schemas.workspace.setAutoCompactionThreshold.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.setAutoCompactionThreshold(
            input.workspaceId,
            input.threshold
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      interruptStream: t
        .input(schemas.workspace.interruptStream.input)
        .output(schemas.workspace.interruptStream.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.interruptStream(
            input.workspaceId,
            input.options
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      clearQueue: t
        .input(schemas.workspace.clearQueue.input)
        .output(schemas.workspace.clearQueue.output)
        .handler(({ context, input }) => {
          const result = context.workspaceService.clearQueue(input.workspaceId);
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      truncateHistory: t
        .input(schemas.workspace.truncateHistory.input)
        .output(schemas.workspace.truncateHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.truncateHistory(
            input.workspaceId,
            input.percentage
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      replaceChatHistory: t
        .input(schemas.workspace.replaceChatHistory.input)
        .output(schemas.workspace.replaceChatHistory.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.replaceHistory(
            input.workspaceId,
            input.summaryMessage,
            { mode: input.mode, deletePlanFile: input.deletePlanFile }
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: undefined };
        }),
      getDevcontainerInfo: t
        .input(schemas.workspace.getDevcontainerInfo.input)
        .output(schemas.workspace.getDevcontainerInfo.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getDevcontainerInfo(input.workspaceId);
        }),
      getInfo: t
        .input(schemas.workspace.getInfo.input)
        .output(schemas.workspace.getInfo.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getInfo(input.workspaceId);
        }),
      getLastLlmRequest: t
        .input(schemas.workspace.getLastLlmRequest.input)
        .output(schemas.workspace.getLastLlmRequest.output)
        .handler(({ context, input }) => {
          return context.aiService.debugGetLastLlmRequest(input.workspaceId);
        }),
      getFullReplay: t
        .input(schemas.workspace.getFullReplay.input)
        .output(schemas.workspace.getFullReplay.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getFullReplay(input.workspaceId);
        }),
      getSubagentTranscript: t
        .input(schemas.workspace.getSubagentTranscript.input)
        .output(schemas.workspace.getSubagentTranscript.output)
        .handler(async ({ context, input }) => {
          const taskId = input.taskId.trim();
          assert(taskId.length > 0, "workspace.getSubagentTranscript: taskId must be non-empty");

          const requestingWorkspaceIdTrimmed = input.workspaceId?.trim();
          const requestingWorkspaceId =
            requestingWorkspaceIdTrimmed && requestingWorkspaceIdTrimmed.length > 0
              ? requestingWorkspaceIdTrimmed
              : null;

          const tryLoadFromWorkspace = async (
            workspaceId: string
          ): Promise<{
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null> => {
            const sessionDir = context.config.getSessionDir(workspaceId);
            const artifacts = await readSubagentTranscriptArtifactsFile(sessionDir);
            const entry = artifacts.artifactsByChildTaskId[taskId] ?? null;
            return entry ? { workspaceId, entry } : null;
          };

          const tryLoadFromDescendantWorkspaces = async (
            ancestorWorkspaceId: string
          ): Promise<{
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null> => {
            // If a grandchild task has already been cleaned up, its transcript is archived into the
            // immediate parent workspace's session dir. Until that parent workspace is cleaned up and
            // its artifacts are rolled up, the requesting workspace won't have the transcript index.
            const descendants = context.taskService.listDescendantAgentTasks(ancestorWorkspaceId);

            // Prefer shallower tasks first so we find the owning parent quickly.
            descendants.sort((a, b) => a.depth - b.depth);

            for (const descendant of descendants) {
              const loaded = await tryLoadFromWorkspace(descendant.taskId);
              if (loaded) return loaded;
            }

            return null;
          };

          // Auth: allow if the task is a descendant OR if we have an on-disk transcript artifact entry.
          // The descendant check is best-effort: if it throws (corrupt config), we fall back to the
          // artifact existence check to keep the UI usable.
          let isDescendant = false;
          if (requestingWorkspaceId) {
            try {
              isDescendant = await context.taskService.isDescendantAgentTask(
                requestingWorkspaceId,
                taskId
              );
            } catch (error: unknown) {
              log.warn("workspace.getSubagentTranscript: descendant check failed", {
                requestingWorkspaceId,
                taskId,
                error: getErrorMessage(error),
              });
            }
          }

          const readTranscriptFromPaths = async (params: {
            workspaceId: string;
            chatPath?: string;
            partialPath?: string;
            logLabel: string;
          }): Promise<MuxMessage[]> => {
            const workspaceSessionDir = context.config.getSessionDir(params.workspaceId);

            // Defense-in-depth: refuse path traversal from a corrupted index file.
            if (params.chatPath && !isPathInsideDir(workspaceSessionDir, params.chatPath)) {
              throw new Error("Refusing to read transcript outside workspace session dir");
            }
            if (params.partialPath && !isPathInsideDir(workspaceSessionDir, params.partialPath)) {
              throw new Error("Refusing to read partial outside workspace session dir");
            }

            const partial = params.partialPath
              ? await readPartialJsonBestEffort(params.partialPath)
              : null;
            const messages = params.chatPath
              ? await readChatJsonlAllowMissing({
                  chatPath: params.chatPath,
                  logLabel: params.logLabel,
                })
              : null;

            // If we only archived partial.json (e.g. interrupted stream), still allow viewing.
            if (!messages && !partial) {
              throw new Error(`Transcript not found (missing ${params.logLabel})`);
            }

            return mergePartialIntoHistory(messages ?? [], partial);
          };

          let resolved: {
            workspaceId: string;
            entry: SubagentTranscriptArtifactIndexEntry;
          } | null = null;
          let hasArtifactInRequestingTree = false;

          if (requestingWorkspaceId !== null) {
            resolved = await tryLoadFromWorkspace(requestingWorkspaceId);
            if (resolved) {
              hasArtifactInRequestingTree = true;
            } else {
              resolved = await tryLoadFromDescendantWorkspaces(requestingWorkspaceId);
              hasArtifactInRequestingTree = resolved !== null;
            }
          } else {
            resolved = await findSubagentTranscriptEntryByScanningSessions({
              sessionsDir: context.config.sessionsDir,
              taskId,
            });
          }

          // If the transcript hasn't been archived yet (common while patch artifacts are pending),
          // fall back to reading from the task's live session dir while it still exists.
          if (!resolved) {
            if (requestingWorkspaceId && isDescendant) {
              const taskSessionDir = context.config.getSessionDir(taskId);
              const messages = await readTranscriptFromPaths({
                workspaceId: taskId,
                chatPath: path.join(taskSessionDir, "chat.jsonl"),
                partialPath: path.join(taskSessionDir, "partial.json"),
                logLabel: `${taskId}/chat.jsonl`,
              });

              const metaResult = await context.aiService.getWorkspaceMetadata(taskId);
              const model =
                metaResult.success &&
                typeof metaResult.data.taskModelString === "string" &&
                metaResult.data.taskModelString.trim().length > 0
                  ? metaResult.data.taskModelString.trim()
                  : undefined;
              const thinkingLevel = metaResult.success
                ? coerceThinkingLevel(metaResult.data.taskThinkingLevel)
                : undefined;

              return { messages, model, thinkingLevel };
            }

            // Helpful error message for UI.
            throw new Error(
              requestingWorkspaceId
                ? `No transcript found for task ${taskId} in workspace ${requestingWorkspaceId}`
                : `No transcript found for task ${taskId}`
            );
          }

          if (requestingWorkspaceId && !isDescendant && !hasArtifactInRequestingTree) {
            throw new Error("Task is not a descendant of this workspace");
          }

          const messages = await readTranscriptFromPaths({
            workspaceId: resolved.workspaceId,
            chatPath: resolved.entry.chatPath,
            partialPath: resolved.entry.partialPath,
            logLabel: `${resolved.workspaceId}/subagent-transcripts/${taskId}/chat.jsonl`,
          });

          const model =
            typeof resolved.entry.model === "string" && resolved.entry.model.trim().length > 0
              ? resolved.entry.model.trim()
              : undefined;
          const thinkingLevel = coerceThinkingLevel(resolved.entry.thinkingLevel);

          return { messages, model, thinkingLevel };
        }),
      executeBash: t
        .input(schemas.workspace.executeBash.input)
        .output(schemas.workspace.executeBash.output)
        .handler(async ({ context, input }) => {
          const result = await context.workspaceService.executeBash(
            input.workspaceId,
            input.script,
            input.options
          );
          if (!result.success) {
            return { success: false, error: result.error };
          }
          return { success: true, data: result.data };
        }),
      getFileCompletions: t
        .input(schemas.workspace.getFileCompletions.input)
        .output(schemas.workspace.getFileCompletions.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.getFileCompletions(
            input.workspaceId,
            input.query,
            input.limit
          );
        }),
      onChat: t
        .input(schemas.workspace.onChat.input)
        .output(schemas.workspace.onChat.output)
        .handler(async function* ({ context, input, signal }) {
          const session = context.workspaceService.getOrCreateSession(input.workspaceId);
          if (typeof input.legacyAutoRetryEnabled === "boolean") {
            session.setLegacyAutoRetryEnabledHint(input.legacyAutoRetryEnabled);
          }

          const { push, iterate, end } = createAsyncMessageQueue<WorkspaceChatMessage>();

          const onAbort = () => {
            // Ensure we tear down the async generator even if the client stops iterating without
            // calling iterator.return(). This prevents orphaned heartbeat intervals.
            end();
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          // 1. Subscribe to new events (including those triggered by replay)
          //
          // IMPORTANT: We subscribe before replay so we can receive stream replay (`replayStream()`)
          // and init replay events (which do not set `replay: true`).
          //
          // Live stream deltas can overlap with replayed deltas on reconnect. Buffer live stream
          // events during replay and flush after `caught-up`, skipping any deltas already delivered
          // by replay.
          const replayRelay = createReplayBufferedStreamMessageRelay(push);

          const unsubscribe = session.onChatEvent(({ message }) => {
            replayRelay.handleSessionMessage(message);
          });

          // 2. Replay history (sends caught-up at the end)
          await session.replayHistory(({ message }) => {
            push(message);
          }, input.mode);

          replayRelay.finishReplay();

          // Startup recovery: after replay catches the client up, recover any
          // crash-stranded compaction follow-ups and then evaluate auto-retry.
          session.scheduleStartupRecovery();

          // 3. Heartbeat to keep the connection alive during long operations (tool calls, subagents).
          // Client uses this to detect stalled connections vs. intentionally idle streams.
          const HEARTBEAT_INTERVAL_MS = 5_000;
          const heartbeatInterval = setInterval(() => {
            push({ type: "heartbeat" });
          }, HEARTBEAT_INTERVAL_MS);

          try {
            yield* iterate();
          } finally {
            clearInterval(heartbeatInterval);
            signal?.removeEventListener("abort", onAbort);
            end();
            unsubscribe();
          }
        }),
      onMetadata: t
        .input(schemas.workspace.onMetadata.input)
        .output(schemas.workspace.onMetadata.output)
        .handler(async function* ({ context, signal }) {
          const service = context.workspaceService;

          interface MetadataEvent {
            workspaceId: string;
            metadata: FrontendWorkspaceMetadataSchemaType | null;
          }

          let resolveNext: ((value: MetadataEvent | null) => void) | null = null;
          const queue: MetadataEvent[] = [];
          let ended = false;

          const push = (event: MetadataEvent) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(event);
            } else {
              queue.push(event);
            }
          };

          const onMetadata = (event: MetadataEvent) => {
            push(event);
          };

          service.on("metadata", onMetadata);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            if (signal.aborted) {
              onAbort();
            } else {
              signal.addEventListener("abort", onAbort, { once: true });
            }
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const event = await new Promise<MetadataEvent | null>((resolve) => {
                resolveNext = resolve;
              });

              if (event === null || ended) {
                break;
              }

              yield event;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            service.off("metadata", onMetadata);
          }
        }),
      activity: {
        list: t
          .input(schemas.workspace.activity.list.input)
          .output(schemas.workspace.activity.list.output)
          .handler(async ({ context }) => {
            return context.workspaceService.getActivityList();
          }),
        subscribe: t
          .input(schemas.workspace.activity.subscribe.input)
          .output(schemas.workspace.activity.subscribe.output)
          .handler(async function* ({ context, signal }) {
            const service = context.workspaceService;

            interface ActivityEvent {
              workspaceId: string;
              activity: WorkspaceActivitySnapshot | null;
            }

            let resolveNext: ((value: ActivityEvent | null) => void) | null = null;
            const queue: ActivityEvent[] = [];
            let ended = false;

            const push = (event: ActivityEvent) => {
              if (ended) return;
              if (resolveNext) {
                const resolve = resolveNext;
                resolveNext = null;
                resolve(event);
              } else {
                queue.push(event);
              }
            };

            const onActivity = (event: ActivityEvent) => {
              push(event);
            };

            service.on("activity", onActivity);

            const onAbort = () => {
              if (ended) return;
              ended = true;

              if (resolveNext) {
                const resolve = resolveNext;
                resolveNext = null;
                resolve(null);
              }
            };

            if (signal) {
              if (signal.aborted) {
                onAbort();
              } else {
                signal.addEventListener("abort", onAbort, { once: true });
              }
            }

            try {
              while (!ended) {
                if (queue.length > 0) {
                  yield queue.shift()!;
                  continue;
                }

                const event = await new Promise<ActivityEvent | null>((resolve) => {
                  resolveNext = resolve;
                });

                if (event === null || ended) {
                  break;
                }

                yield event;
              }
            } finally {
              ended = true;
              signal?.removeEventListener("abort", onAbort);
              service.off("activity", onActivity);
            }
          }),
      },
      history: {
        loadMore: t
          .input(schemas.workspace.history.loadMore.input)
          .output(schemas.workspace.history.loadMore.output)
          .handler(async ({ context, input }) => {
            return context.workspaceService.getHistoryLoadMore(input.workspaceId, input.cursor);
          }),
      },
      getPlanContent: t
        .input(schemas.workspace.getPlanContent.input)
        .output(schemas.workspace.getPlanContent.output)
        .handler(async ({ context, input }) => {
          // Get workspace metadata to determine runtime and paths
          const metadata = await context.workspaceService.getInfo(input.workspaceId);
          if (!metadata) {
            return { success: false as const, error: `Workspace not found: ${input.workspaceId}` };
          }

          // Create runtime to read plan file (supports both local and SSH)
          const runtime = createRuntimeForWorkspace(metadata);

          const result = await readPlanFile(
            runtime,
            metadata.name,
            metadata.projectName,
            input.workspaceId
          );

          if (!result.exists) {
            return { success: false as const, error: `Plan file not found at ${result.path}` };
          }
          return { success: true as const, data: { content: result.content, path: result.path } };
        }),
      backgroundBashes: {
        subscribe: t
          .input(schemas.workspace.backgroundBashes.subscribe.input)
          .output(schemas.workspace.backgroundBashes.subscribe.output)
          .handler(async function* ({ context, input, signal }) {
            const service = context.workspaceService;
            const { workspaceId } = input;

            if (signal?.aborted) {
              return;
            }

            const getState = async () => ({
              processes: await service.listBackgroundProcesses(workspaceId),
              foregroundToolCallIds: service.getForegroundToolCallIds(workspaceId),
            });

            const queue = createAsyncEventQueue<Awaited<ReturnType<typeof getState>>>();

            const onAbort = () => {
              queue.end();
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            const onChange = (changedWorkspaceId: string) => {
              if (changedWorkspaceId === workspaceId) {
                void getState().then(queue.push);
              }
            };

            service.onBackgroundBashChange(onChange);

            try {
              // Emit initial state immediately
              yield await getState();
              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              queue.end();
              service.offBackgroundBashChange(onChange);
            }
          }),
        terminate: t
          .input(schemas.workspace.backgroundBashes.terminate.input)
          .output(schemas.workspace.backgroundBashes.terminate.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.terminateBackgroundProcess(
              input.workspaceId,
              input.processId
            );
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: undefined };
          }),
        sendToBackground: t
          .input(schemas.workspace.backgroundBashes.sendToBackground.input)
          .output(schemas.workspace.backgroundBashes.sendToBackground.output)
          .handler(({ context, input }) => {
            const result = context.workspaceService.sendToBackground(input.toolCallId);
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: undefined };
          }),
        getOutput: t
          .input(schemas.workspace.backgroundBashes.getOutput.input)
          .output(schemas.workspace.backgroundBashes.getOutput.output)
          .handler(async ({ context, input }) => {
            const result = await context.workspaceService.getBackgroundProcessOutput(
              input.workspaceId,
              input.processId,
              { fromOffset: input.fromOffset, tailBytes: input.tailBytes }
            );
            if (!result.success) {
              return { success: false, error: result.error };
            }
            return { success: true, data: result.data };
          }),
      },
      getPostCompactionState: t
        .input(schemas.workspace.getPostCompactionState.input)
        .output(schemas.workspace.getPostCompactionState.output)
        .handler(({ context, input }) => {
          return context.workspaceService.getPostCompactionState(input.workspaceId);
        }),
      setPostCompactionExclusion: t
        .input(schemas.workspace.setPostCompactionExclusion.input)
        .output(schemas.workspace.setPostCompactionExclusion.output)
        .handler(async ({ context, input }) => {
          return context.workspaceService.setPostCompactionExclusion(
            input.workspaceId,
            input.itemId,
            input.excluded
          );
        }),
      getSessionUsage: t
        .input(schemas.workspace.getSessionUsage.input)
        .output(schemas.workspace.getSessionUsage.output)
        .handler(async ({ context, input }) => {
          return context.sessionUsageService.getSessionUsage(input.workspaceId);
        }),
      getSessionUsageBatch: t
        .input(schemas.workspace.getSessionUsageBatch.input)
        .output(schemas.workspace.getSessionUsageBatch.output)
        .handler(async ({ context, input }) => {
          return context.sessionUsageService.getSessionUsageBatch(input.workspaceIds);
        }),
      stats: {
        subscribe: t
          .input(schemas.workspace.stats.subscribe.input)
          .output(schemas.workspace.stats.subscribe.output)
          .handler(async function* ({ context, input, signal }) {
            const workspaceId = input.workspaceId;

            if (signal?.aborted) {
              return;
            }

            context.sessionTimingService.addSubscriber(workspaceId);

            const queue = (() => {
              // Coalesce snapshots: keep only the most recent snapshot to avoid an
              // unbounded queue under high-frequency stream deltas.
              let buffered: WorkspaceStatsSnapshot | undefined;
              let hasBuffered = false;
              let resolveNext: ((value: WorkspaceStatsSnapshot | null) => void) | null = null;
              let ended = false;

              const push = (value: WorkspaceStatsSnapshot) => {
                if (ended) return;

                if (resolveNext) {
                  const resolve = resolveNext;
                  resolveNext = null;
                  resolve(value);
                  return;
                }

                buffered = value;
                hasBuffered = true;
              };

              async function* iterate(): AsyncGenerator<WorkspaceStatsSnapshot> {
                while (true) {
                  if (ended) {
                    return;
                  }

                  if (hasBuffered) {
                    const value = buffered;
                    buffered = undefined;
                    hasBuffered = false;
                    if (value !== undefined) {
                      yield value;
                    }
                    continue;
                  }

                  const next = await new Promise<WorkspaceStatsSnapshot | null>((resolve) => {
                    resolveNext = resolve;
                  });

                  if (ended || next === null) {
                    return;
                  }

                  yield next;
                }
              }

              const end = () => {
                ended = true;
                if (resolveNext) {
                  const resolve = resolveNext;
                  resolveNext = null;
                  resolve(null);
                }
              };

              return { push, iterate, end };
            })();

            // Snapshot computation is async; without coalescing, we can build an unbounded
            // backlog when token deltas arrive quickly.
            const SNAPSHOT_THROTTLE_MS = 100;

            let lastPushedAtMs = 0;
            let inFlight = false;
            let pendingTimer: ReturnType<typeof setTimeout> | undefined;
            let pendingSnapshot = false;
            let closed = false;

            const onAbort = () => {
              closed = true;

              if (pendingTimer) {
                clearTimeout(pendingTimer);
                pendingTimer = undefined;
              }

              queue.end();
            };

            if (signal) {
              signal.addEventListener("abort", onAbort, { once: true });
            }

            const pushSnapshot = async () => {
              if (closed) return;
              if (inFlight) return;
              if (!pendingSnapshot) return;

              pendingSnapshot = false;
              inFlight = true;

              try {
                const snapshot = await context.sessionTimingService.getSnapshot(workspaceId);
                if (closed) return;

                lastPushedAtMs = snapshot.generatedAt;
                queue.push(snapshot);
              } finally {
                inFlight = false;

                if (!closed && pendingSnapshot) {
                  scheduleSnapshot();
                }
              }
            };

            const runPushSnapshot = () => {
              void pushSnapshot().catch(() => {
                // Defensive: a failed snapshot fetch should never brick the subscription.
              });
            };

            const scheduleSnapshot = () => {
              pendingSnapshot = true;

              if (closed) {
                return;
              }

              if (inFlight) {
                return;
              }

              if (pendingTimer) {
                return;
              }

              const now = Date.now();
              const timeSinceLastPush = now - lastPushedAtMs;

              if (timeSinceLastPush >= SNAPSHOT_THROTTLE_MS) {
                runPushSnapshot();
                return;
              }

              const remaining = SNAPSHOT_THROTTLE_MS - timeSinceLastPush;
              pendingTimer = setTimeout(() => {
                pendingTimer = undefined;
                runPushSnapshot();
              }, remaining);

              // Avoid keeping Node (or Jest workers) alive due to a leaked throttle timer.
              pendingTimer.unref?.();
            };

            const onChange = (changedWorkspaceId: string) => {
              if (changedWorkspaceId !== workspaceId) {
                return;
              }
              scheduleSnapshot();
            };

            // Subscribe before awaiting the initial snapshot so we don't miss a
            // stats-change event that happens while getSnapshot() is in-flight.
            //
            // Treat the initial snapshot fetch as inFlight to prevent scheduleSnapshot()
            // from starting a concurrent fetch that could push a newer snapshot before
            // the initial one.
            inFlight = true;
            context.sessionTimingService.onStatsChange(onChange);

            try {
              const initial = await context.sessionTimingService.getSnapshot(workspaceId);
              lastPushedAtMs = initial.generatedAt;
              queue.push(initial);
            } finally {
              inFlight = false;

              if (!closed && pendingSnapshot) {
                scheduleSnapshot();
              }
            }

            try {
              yield* queue.iterate();
            } finally {
              closed = true;
              signal?.removeEventListener("abort", onAbort);
              if (pendingTimer) {
                clearTimeout(pendingTimer);
              }

              queue.end();
              context.sessionTimingService.offStatsChange(onChange);
              context.sessionTimingService.removeSubscriber(workspaceId);
            }
          }),
        clear: t
          .input(schemas.workspace.stats.clear.input)
          .output(schemas.workspace.stats.clear.output)
          .handler(async ({ context, input }) => {
            try {
              await context.sessionTimingService.clearTimingFile(input.workspaceId);
              return { success: true, data: undefined };
            } catch (error) {
              const message = getErrorMessage(error);
              return { success: false, error: message };
            }
          }),
      },
      mcp: {
        get: t
          .input(schemas.workspace.mcp.get.input)
          .output(schemas.workspace.mcp.get.output)
          .handler(async ({ context, input }) => {
            const policy = context.policyService.getEffectivePolicy();
            const mcpDisabledByPolicy =
              context.policyService.isEnforced() &&
              policy?.mcp.allowUserDefined.stdio === false &&
              policy.mcp.allowUserDefined.remote === false;

            if (mcpDisabledByPolicy) {
              return {};
            }

            try {
              return await context.workspaceMcpOverridesService.getOverridesForWorkspace(
                input.workspaceId
              );
            } catch {
              // Defensive: overrides must never brick workspace UI.
              return {};
            }
          }),
        set: t
          .input(schemas.workspace.mcp.set.input)
          .output(schemas.workspace.mcp.set.output)
          .handler(async ({ context, input }) => {
            try {
              await context.workspaceMcpOverridesService.setOverridesForWorkspace(
                input.workspaceId,
                input.overrides
              );
              return { success: true, data: undefined };
            } catch (error) {
              const message = getErrorMessage(error);
              return { success: false, error: message };
            }
          }),
      },
    },
    tasks: {
      create: t
        .input(schemas.tasks.create.input)
        .output(schemas.tasks.create.output)
        .handler(({ context, input }) => {
          const thinkingLevel =
            input.thinkingLevel === "off" ||
            input.thinkingLevel === "low" ||
            input.thinkingLevel === "medium" ||
            input.thinkingLevel === "high" ||
            input.thinkingLevel === "xhigh"
              ? input.thinkingLevel
              : undefined;

          return context.taskService.create({
            parentWorkspaceId: input.parentWorkspaceId,
            kind: input.kind,
            agentId: input.agentId,
            agentType: input.agentType,
            prompt: input.prompt,
            title: input.title,
            modelString: input.modelString,
            thinkingLevel,
          });
        }),
    },
    window: {
      setTitle: t
        .input(schemas.window.setTitle.input)
        .output(schemas.window.setTitle.output)
        .handler(({ context, input }) => {
          return context.windowService.setTitle(input.title);
        }),
    },
    terminal: {
      create: t
        .input(schemas.terminal.create.input)
        .output(schemas.terminal.create.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.create(input);
        }),
      close: t
        .input(schemas.terminal.close.input)
        .output(schemas.terminal.close.output)
        .handler(({ context, input }) => {
          return context.terminalService.close(input.sessionId);
        }),
      resize: t
        .input(schemas.terminal.resize.input)
        .output(schemas.terminal.resize.output)
        .handler(({ context, input }) => {
          return context.terminalService.resize(input);
        }),
      sendInput: t
        .input(schemas.terminal.sendInput.input)
        .output(schemas.terminal.sendInput.output)
        .handler(({ context, input }) => {
          context.terminalService.sendInput(input.sessionId, input.data);
        }),
      onOutput: t
        .input(schemas.terminal.onOutput.input)
        .output(schemas.terminal.onOutput.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          let resolveNext: ((value: string | null) => void) | null = null;
          const queue: string[] = [];
          let ended = false;

          const push = (data: string) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(data);
            } else {
              queue.push(data);
            }
          };

          const unsubscribe = context.terminalService.onOutput(input.sessionId, push);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const data = await new Promise<string | null>((resolve) => {
                resolveNext = resolve;
              });

              if (data === null || ended) {
                break;
              }

              yield data;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      attach: t
        .input(schemas.terminal.attach.input)
        .output(schemas.terminal.attach.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          type AttachMessage =
            | { type: "screenState"; data: string }
            | { type: "output"; data: string };

          let resolveNext: ((value: AttachMessage | null) => void) | null = null;
          const queue: AttachMessage[] = [];
          let ended = false;

          const push = (msg: AttachMessage) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(msg);
            } else {
              queue.push(msg);
            }
          };

          // CRITICAL: Subscribe to output FIRST, BEFORE capturing screen state.
          // This ensures any output that arrives during/after getScreenState() is queued.
          const unsubscribe = context.terminalService.onOutput(input.sessionId, (data) => {
            push({ type: "output", data });
          });

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            // Capture screen state AFTER subscription is set up - guarantees no missed output
            const screenState = context.terminalService.getScreenState(input.sessionId);

            // First message is always the screen state (may be empty for new sessions)
            yield { type: "screenState" as const, data: screenState };

            // Now yield any queued output and continue with live stream
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                continue;
              }

              const msg = await new Promise<AttachMessage | null>((resolve) => {
                resolveNext = resolve;
              });

              if (msg === null || ended) {
                break;
              }

              yield msg;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      onExit: t
        .input(schemas.terminal.onExit.input)
        .output(schemas.terminal.onExit.output)
        .handler(async function* ({ context, input, signal }) {
          if (signal?.aborted) {
            return;
          }

          let resolveNext: ((value: number | null) => void) | null = null;
          const queue: number[] = [];
          let ended = false;

          const push = (code: number) => {
            if (ended) return;
            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(code);
            } else {
              queue.push(code);
            }
          };

          const unsubscribe = context.terminalService.onExit(input.sessionId, push);

          const onAbort = () => {
            if (ended) return;
            ended = true;

            if (resolveNext) {
              const resolve = resolveNext;
              resolveNext = null;
              resolve(null);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            while (!ended) {
              if (queue.length > 0) {
                yield queue.shift()!;
                // Terminal only exits once, so we can finish the stream
                break;
              }

              const code = await new Promise<number | null>((resolve) => {
                resolveNext = resolve;
              });

              if (code === null || ended) {
                break;
              }

              yield code;
              break;
            }
          } finally {
            ended = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe();
          }
        }),
      openWindow: t
        .input(schemas.terminal.openWindow.input)
        .output(schemas.terminal.openWindow.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openWindow(input.workspaceId, input.sessionId);
        }),
      closeWindow: t
        .input(schemas.terminal.closeWindow.input)
        .output(schemas.terminal.closeWindow.output)
        .handler(({ context, input }) => {
          return context.terminalService.closeWindow(input.workspaceId);
        }),
      listSessions: t
        .input(schemas.terminal.listSessions.input)
        .output(schemas.terminal.listSessions.output)
        .handler(({ context, input }) => {
          return context.terminalService.getWorkspaceSessionIds(input.workspaceId);
        }),
      openNative: t
        .input(schemas.terminal.openNative.input)
        .output(schemas.terminal.openNative.output)
        .handler(async ({ context, input }) => {
          return context.terminalService.openNative(input.workspaceId);
        }),
    },
    update: {
      check: t
        .input(schemas.update.check.input)
        .output(schemas.update.check.output)
        .handler(async ({ context, input }) => {
          return context.updateService.check(input ?? undefined);
        }),
      download: t
        .input(schemas.update.download.input)
        .output(schemas.update.download.output)
        .handler(async ({ context }) => {
          return context.updateService.download();
        }),
      install: t
        .input(schemas.update.install.input)
        .output(schemas.update.install.output)
        .handler(({ context }) => {
          return context.updateService.install();
        }),
      onStatus: t
        .input(schemas.update.onStatus.input)
        .output(schemas.update.onStatus.output)
        .handler(async function* ({ context, signal }) {
          if (signal?.aborted) {
            return;
          }

          const queue = createAsyncEventQueue<UpdateStatus>();
          const unsubscribe = context.updateService.onStatus(queue.push);

          const onAbort = () => {
            queue.end();
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            yield* queue.iterate();
          } finally {
            signal?.removeEventListener("abort", onAbort);
            queue.end();
            unsubscribe();
          }
        }),
      getChannel: t
        .input(schemas.update.getChannel.input)
        .output(schemas.update.getChannel.output)
        .handler(({ context }) => {
          return context.updateService.getChannel();
        }),
      setChannel: t
        .input(schemas.update.setChannel.input)
        .output(schemas.update.setChannel.output)
        .handler(async ({ context, input }) => {
          await context.updateService.setChannel(input.channel);
        }),
    },
    menu: {
      onOpenSettings: t
        .input(schemas.menu.onOpenSettings.input)
        .output(schemas.menu.onOpenSettings.output)
        .handler(async function* ({ context, signal }) {
          if (signal?.aborted) {
            return;
          }

          // Use a sentinel value to signal events since void/undefined can't be queued
          const queue = createAsyncEventQueue<true>();
          const unsubscribe = context.menuEventService.onOpenSettings(() => queue.push(true));

          const onAbort = () => {
            queue.end();
          };

          if (signal) {
            signal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            for await (const _ of queue.iterate()) {
              yield undefined;
            }
          } finally {
            signal?.removeEventListener("abort", onAbort);
            queue.end();
            unsubscribe();
          }
        }),
    },
    voice: {
      transcribe: t
        .input(schemas.voice.transcribe.input)
        .output(schemas.voice.transcribe.output)
        .handler(async ({ context, input }) => {
          return context.voiceService.transcribe(input.audioBase64);
        }),
    },
    experiments: {
      getAll: t
        .input(schemas.experiments.getAll.input)
        .output(schemas.experiments.getAll.output)
        .handler(({ context }) => {
          return context.experimentsService.getAll();
        }),
      reload: t
        .input(schemas.experiments.reload.input)
        .output(schemas.experiments.reload.output)
        .handler(async ({ context }) => {
          await context.experimentsService.refreshAll();
        }),
    },
    debug: {
      triggerStreamError: t
        .input(schemas.debug.triggerStreamError.input)
        .output(schemas.debug.triggerStreamError.output)
        .handler(({ context, input }) => {
          return context.workspaceService.debugTriggerStreamError(
            input.workspaceId,
            input.errorMessage
          );
        }),
    },
    telemetry: {
      track: t
        .input(schemas.telemetry.track.input)
        .output(schemas.telemetry.track.output)
        .handler(({ context, input }) => {
          context.telemetryService.capture(input);
        }),
      status: t
        .input(schemas.telemetry.status.input)
        .output(schemas.telemetry.status.output)
        .handler(({ context }) => {
          return {
            enabled: context.telemetryService.isEnabled(),
            explicit: context.telemetryService.isExplicitlyDisabled(),
          };
        }),
    },
    signing: {
      capabilities: t
        .input(schemas.signing.capabilities.input)
        .output(schemas.signing.capabilities.output)
        .handler(async ({ context }) => {
          return context.signingService.getCapabilities();
        }),
      signMessage: t
        .input(schemas.signing.signMessage.input)
        .output(schemas.signing.signMessage.output)
        .handler(({ context, input }) => {
          return context.signingService.signMessage(input.content);
        }),
      clearIdentityCache: t
        .input(schemas.signing.clearIdentityCache.input)
        .output(schemas.signing.clearIdentityCache.output)
        .handler(({ context }) => {
          context.signingService.clearIdentityCache();
          return { success: true };
        }),
    },
    analytics: {
      getSummary: t
        .input(schemas.analytics.getSummary.input)
        .output(schemas.analytics.getSummary.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSummary(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getSpendOverTime: t
        .input(schemas.analytics.getSpendOverTime.input)
        .output(schemas.analytics.getSpendOverTime.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendOverTime(input);
        }),
      getSpendByProject: t
        .input(schemas.analytics.getSpendByProject.input)
        .output(schemas.analytics.getSpendByProject.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendByProject(input.from ?? null, input.to ?? null);
        }),
      getSpendByModel: t
        .input(schemas.analytics.getSpendByModel.input)
        .output(schemas.analytics.getSpendByModel.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getSpendByModel(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getTimingDistribution: t
        .input(schemas.analytics.getTimingDistribution.input)
        .output(schemas.analytics.getTimingDistribution.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getTimingDistribution(
            input.metric,
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getAgentCostBreakdown: t
        .input(schemas.analytics.getAgentCostBreakdown.input)
        .output(schemas.analytics.getAgentCostBreakdown.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getAgentCostBreakdown(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      getCacheHitRatioByProvider: t
        .input(schemas.analytics.getCacheHitRatioByProvider.input)
        .output(schemas.analytics.getCacheHitRatioByProvider.output)
        .handler(async ({ context, input }) => {
          return context.analyticsService.getCacheHitRatioByProvider(
            input.projectPath ?? null,
            input.from ?? null,
            input.to ?? null
          );
        }),
      rebuildDatabase: t
        .input(schemas.analytics.rebuildDatabase.input)
        .output(schemas.analytics.rebuildDatabase.output)
        .handler(async ({ context }) => {
          return context.analyticsService.rebuildAll();
        }),
    },
    ssh: {
      prompt: {
        subscribe: t
          .input(schemas.ssh.prompt.subscribe.input)
          .output(schemas.ssh.prompt.subscribe.output)
          .handler(async function* ({ context, signal }) {
            if (signal?.aborted) return;

            const service = context.sshPromptService;
            const releaseResponder = service.registerInteractiveResponder();
            const queue = createAsyncEventQueue<SshPromptEvent>();

            const onRequest = (req: SshPromptRequest) =>
              queue.push({ type: "request" as const, ...req });
            const onRemoved = (requestId: string) =>
              queue.push({ type: "removed" as const, requestId });

            // Atomic handshake: register listener + snapshot in one step.
            // No requests can be lost between snapshot and subscription.
            const { snapshot, unsubscribe } = service.subscribeRequests(onRequest, onRemoved);
            for (const req of snapshot) {
              queue.push({ type: "request" as const, ...req });
            }

            const onAbort = () => queue.end();
            signal?.addEventListener("abort", onAbort, { once: true });

            try {
              yield* queue.iterate();
            } finally {
              signal?.removeEventListener("abort", onAbort);
              releaseResponder();
              queue.end();
              unsubscribe();
            }
          }),
        respond: t
          .input(schemas.ssh.prompt.respond.input)
          .output(schemas.ssh.prompt.respond.output)
          .handler(({ context, input }) => {
            context.sshPromptService.respond(input.requestId, input.response);
            return Ok(undefined);
          }),
      },
    },
  });
};

export type AppRouter = ReturnType<typeof router>;
