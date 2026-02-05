import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import assert from "@/common/utils/assert";
import { EventEmitter } from "events";
import type { XaiProviderOptions } from "@ai-sdk/xai";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { convertToModelMessages, type LanguageModel, type Tool } from "ai";
import { applyToolOutputRedaction } from "@/browser/utils/messages/applyToolOutputRedaction";
import { sanitizeToolInputs } from "@/browser/utils/messages/sanitizeToolInput";
import {
  applySystem1KeepRangesToOutput,
  formatNumberedLinesForSystem1,
  formatSystem1BashFilterNotice,
  getHeuristicKeepRangesForBashOutput,
  splitBashOutputLines,
} from "@/node/services/system1/bashOutputFiltering";
import { decideBashOutputCompaction } from "@/node/services/system1/bashCompactionPolicy";
import { truncateBashOutput } from "@/common/utils/truncateBashOutput";
import { runSystem1KeepRangesForBashOutput } from "@/node/services/system1/system1AgentRunner";
import {
  formatBashOutputReport,
  tryParseBashOutputReport,
} from "@/node/services/tools/bashTaskReport";
import { linkAbortSignal } from "@/node/utils/abort";
import { inlineSvgAsTextForProvider } from "@/node/utils/messages/inlineSvgAsTextForProvider";
import { extractToolMediaAsUserMessages } from "@/node/utils/messages/extractToolMediaAsUserMessages";
import { sanitizeAnthropicPdfFilenames } from "@/node/utils/messages/sanitizeAnthropicDocumentFilename";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { WorkspaceMetadata } from "@/common/types/workspace";
import type { SendMessageOptions } from "@/common/orpc/types";
import { AgentIdSchema } from "@/common/orpc/schemas";
import {
  PROVIDER_REGISTRY,
  PROVIDER_DEFINITIONS,
  MUX_GATEWAY_SUPPORTED_PROVIDERS,
  type ProviderName,
} from "@/common/constants/providers";

import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import type { BashOutputEvent } from "@/common/types/stream";
import type { MuxMessage, MuxTextPart } from "@/common/types/message";
import { createMuxMessage } from "@/common/types/message";
import type { Config, ProviderConfig } from "@/node/config";
import { StreamManager } from "./streamManager";
import type { InitStateManager } from "./initStateManager";
import type { SendMessageError } from "@/common/types/errors";
import { getToolsForModel } from "@/common/utils/tools/tools";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getMuxEnv, getRuntimeType } from "@/node/runtime/initHook";
import { MUX_HELP_CHAT_AGENT_ID, MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import { secretsToRecord } from "@/common/types/secrets";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { PolicyService } from "@/node/services/policyService";
import type { ProviderService } from "@/node/services/providerService";
import type { BackgroundProcessManager } from "@/node/services/backgroundProcessManager";
import type { FileState, EditedFileAttachment } from "@/node/services/agentSession";
import { log } from "./log";
import { injectFileAtMentions } from "./fileAtMentions";
import {
  transformModelMessages,
  validateAnthropicCompliance,
  addInterruptedSentinel,
  filterEmptyAssistantMessages,
  injectAgentTransition,
  injectFileChangeNotifications,
  injectPostCompactionAttachments,
} from "@/browser/utils/messages/modelMessageTransform";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { applyCacheControl } from "@/common/utils/ai/cacheStrategy";
import type { HistoryService } from "./historyService";
import type { PartialService } from "./partialService";
import { createErrorEvent } from "./utils/sendMessageError";
import { createAssistantMessageId } from "./utils/messageIds";
import type { SessionUsageService } from "./sessionUsageService";
import { sumUsageHistory, getTotalCost } from "@/common/utils/tokens/usageAggregator";
import { buildSystemMessage, readToolInstructions } from "./systemMessage";
import { getTokenizerForModel } from "@/node/utils/main/tokenizer";
import type { TelemetryService } from "@/node/services/telemetryService";
import { getRuntimeTypeForTelemetry, roundToBase2 } from "@/common/telemetry/utils";
import type { WorkspaceMCPOverrides } from "@/common/types/mcp";
import type { MCPServerManager, MCPWorkspaceStats } from "@/node/services/mcpServerManager";
import { WorkspaceMcpOverridesService } from "./workspaceMcpOverridesService";
import type { TaskService } from "@/node/services/taskService";
import { buildProviderOptions } from "@/common/utils/ai/providerOptions";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { resolveProviderCredentials } from "@/node/utils/providerRequirements";
import type { ThinkingLevel } from "@/common/types/thinking";
import { DEFAULT_TASK_SETTINGS, SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS } from "@/common/types/tasks";
import type {
  StreamAbortEvent,
  StreamAbortReason,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamStartEvent,
} from "@/common/types/stream";
import { applyToolPolicy, type ToolPolicy } from "@/common/utils/tools/toolPolicy";
// PTC types only - modules lazy-loaded to avoid loading typescript/prettier at startup
import type {
  PTCEventWithParent,
  createCodeExecutionTool as CreateCodeExecutionToolFn,
} from "@/node/services/tools/code_execution";
import type { QuickJSRuntimeFactory } from "@/node/services/ptc/quickjsRuntime";
import type { ToolBridge } from "@/node/services/ptc/toolBridge";
import { MockAiStreamPlayer } from "./mock/mockAiStreamPlayer";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { hasStartHerePlanSummary } from "@/common/utils/messages/startHerePlanSummary";
import { getPlanFilePath } from "@/common/utils/planStorage";
import { getPlanFileHint, getPlanModeInstruction } from "@/common/utils/ui/modeUtils";
import { MUX_APP_ATTRIBUTION_TITLE, MUX_APP_ATTRIBUTION_URL } from "@/constants/appAttribution";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  readAgentDefinition,
  resolveAgentBody,
  resolveAgentFrontmatter,
  discoverAgentDefinitions,
  type AgentDefinitionsRoots,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { resolveToolPolicyForAgent } from "@/node/services/agentDefinitions/resolveToolPolicy";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { discoverAgentSkills } from "@/node/services/agentSkills/agentSkillsService";

// Export a standalone version of getToolsForModel for use in backend

// Create undici agent with unlimited timeouts for AI streaming requests.
// Safe because users control cancellation via AbortSignal from the UI.
// Uses EnvHttpProxyAgent to automatically respect HTTP_PROXY, HTTPS_PROXY,
// and NO_PROXY environment variables for debugging/corporate network support.
const unlimitedTimeoutAgent = new EnvHttpProxyAgent({
  bodyTimeout: 0, // No timeout - prevents BodyTimeoutError on long reasoning pauses
  headersTimeout: 0, // No timeout for headers
});

// Extend RequestInit with undici-specific dispatcher property (Node.js only)
type RequestInitWithDispatcher = RequestInit & { dispatcher?: Dispatcher };

/**
 * Default fetch function with unlimited timeouts for AI streaming.
 * Uses undici Agent to remove artificial timeout limits while still
 * respecting user cancellation via AbortSignal.
 *
 * Note: If users provide custom fetch in providers.jsonc, they are
 * responsible for configuring timeouts appropriately. Custom fetch
 * implementations using undici should set bodyTimeout: 0 and
 * headersTimeout: 0 to prevent BodyTimeoutError on long-running
 * reasoning models.
 */
const defaultFetchWithUnlimitedTimeout = (async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  // dispatcher is a Node.js undici-specific property for custom HTTP agents
  const requestInit: RequestInitWithDispatcher = {
    ...(init ?? {}),
    dispatcher: unlimitedTimeoutAgent,
  };
  return fetch(input, requestInit);
}) as typeof fetch;

type FetchWithBunExtensions = typeof fetch & {
  preconnect?: typeof fetch extends { preconnect: infer P } ? P : unknown;
  certificate?: typeof fetch extends { certificate: infer C } ? C : unknown;
};

const globalFetchWithExtras = fetch as FetchWithBunExtensions;
const defaultFetchWithExtras = defaultFetchWithUnlimitedTimeout as FetchWithBunExtensions;

// Lazy-loaded PTC modules (only loaded when experiment is enabled)
// This avoids loading typescript/prettier at startup which causes issues:
// - Integration tests fail without --experimental-vm-modules (prettier uses dynamic imports)
// - Smoke tests fail if typescript isn't in production bundle
// Dynamic imports are justified: PTC pulls in ~10MB of dependencies that would slow startup.
interface PTCModules {
  createCodeExecutionTool: typeof CreateCodeExecutionToolFn;
  QuickJSRuntimeFactory: typeof QuickJSRuntimeFactory;
  ToolBridge: typeof ToolBridge;
  runtimeFactory: QuickJSRuntimeFactory | null;
}
let ptcModules: PTCModules | null = null;

async function getPTCModules(): Promise<PTCModules> {
  if (ptcModules) return ptcModules;

  /* eslint-disable no-restricted-syntax -- Dynamic imports required here to avoid loading
     ~10MB of typescript/prettier/quickjs at startup (causes CI failures) */
  const [codeExecution, quickjs, toolBridge] = await Promise.all([
    import("@/node/services/tools/code_execution"),
    import("@/node/services/ptc/quickjsRuntime"),
    import("@/node/services/ptc/toolBridge"),
  ]);
  /* eslint-enable no-restricted-syntax */

  ptcModules = {
    createCodeExecutionTool: codeExecution.createCodeExecutionTool,
    QuickJSRuntimeFactory: quickjs.QuickJSRuntimeFactory,
    ToolBridge: toolBridge.ToolBridge,
    runtimeFactory: null,
  };
  return ptcModules;
}

if (typeof globalFetchWithExtras.preconnect === "function") {
  defaultFetchWithExtras.preconnect = globalFetchWithExtras.preconnect.bind(globalFetchWithExtras);
}

if (typeof globalFetchWithExtras.certificate === "function") {
  defaultFetchWithExtras.certificate =
    globalFetchWithExtras.certificate.bind(globalFetchWithExtras);
}

/**
 * Wrap fetch to inject Anthropic cache_control directly into the request body.
 * The AI SDK's providerOptions.anthropic.cacheControl doesn't get translated
 * to raw cache_control for tools or message content parts, so we inject it
 * at the HTTP level.
 *
 * Injects cache_control on:
 * 1. Last tool (caches all tool definitions)
 * 2. Last message's last content part (caches entire conversation)
 */
function wrapFetchWithAnthropicCacheControl(baseFetch: typeof fetch): typeof fetch {
  const cachingFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    // Only modify POST requests with JSON body
    if (init?.method?.toUpperCase() !== "POST" || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }

    try {
      const json = JSON.parse(init.body) as Record<string, unknown>;

      // Inject cache_control on the last tool if tools array exists
      if (Array.isArray(json.tools) && json.tools.length > 0) {
        const lastTool = json.tools[json.tools.length - 1] as Record<string, unknown>;
        lastTool.cache_control ??= { type: "ephemeral" };
      }

      // Inject cache_control on last message's last content part
      // This caches the entire conversation
      // Handle both formats:
      // - Direct Anthropic provider: json.messages (Anthropic API format)
      // - Gateway provider: json.prompt (AI SDK internal format)
      const messages = Array.isArray(json.messages)
        ? json.messages
        : Array.isArray(json.prompt)
          ? json.prompt
          : null;

      if (messages && messages.length >= 1) {
        const lastMsg = messages[messages.length - 1] as Record<string, unknown>;

        // For gateway: add providerOptions.anthropic.cacheControl at message level
        // (gateway validates schema strictly, doesn't allow raw cache_control on messages)
        if (Array.isArray(json.prompt)) {
          const providerOpts = (lastMsg.providerOptions ?? {}) as Record<string, unknown>;
          const anthropicOpts = (providerOpts.anthropic ?? {}) as Record<string, unknown>;
          anthropicOpts.cacheControl ??= { type: "ephemeral" };
          providerOpts.anthropic = anthropicOpts;
          lastMsg.providerOptions = providerOpts;
        }

        // For direct Anthropic: add cache_control to last content part
        const content = lastMsg.content;
        if (Array.isArray(content) && content.length > 0) {
          const lastPart = content[content.length - 1] as Record<string, unknown>;
          lastPart.cache_control ??= { type: "ephemeral" };
        }
      }

      // Update body with modified JSON
      const newBody = JSON.stringify(json);
      const headers = new Headers(init?.headers);
      headers.delete("content-length"); // Body size changed
      return baseFetch(input, { ...init, headers, body: newBody });
    } catch {
      // If parsing fails, pass through unchanged
      return baseFetch(input, init);
    }
  };

  return Object.assign(cachingFetch, baseFetch) as typeof fetch;
}

/**
 * Wrap fetch so any mux-gateway 401 response clears local credentials (best-effort).
 *
 * This ensures the UI immediately reflects that the user has been logged out
 * when the gateway session expires.
 */
function wrapFetchWithMuxGatewayAutoLogout(
  baseFetch: typeof fetch,
  providerService: ProviderService
): typeof fetch {
  const wrappedFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const response = await baseFetch(input, init);

    if (response.status === 401) {
      try {
        providerService.setConfig("mux-gateway", ["couponCode"], "");
        providerService.setConfig("mux-gateway", ["voucher"], "");
      } catch {
        // Ignore failures clearing local credentials
      }
    }

    return response;
  };

  return Object.assign(wrappedFetch, baseFetch) as typeof fetch;
}

/**
 * Get fetch function for provider - use custom if provided, otherwise unlimited timeout default
 */
function getProviderFetch(providerConfig: ProviderConfig): typeof fetch {
  return typeof providerConfig.fetch === "function"
    ? (providerConfig.fetch as typeof fetch)
    : defaultFetchWithUnlimitedTimeout;
}

/**
 * Normalize Anthropic base URL to ensure it ends with /v1 suffix.
 *
 * The Anthropic SDK expects baseURL to include /v1 (default: https://api.anthropic.com/v1).
 * Many users configure base URLs without the /v1 suffix, which causes API calls to fail.
 * This function automatically appends /v1 if missing.
 *
 * @param baseURL - The base URL to normalize (may or may not have /v1)
 * @returns The base URL with /v1 suffix
 */
export function normalizeAnthropicBaseURL(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, ""); // Remove trailing slashes
  if (trimmed.endsWith("/v1")) {
    return trimmed;
  }
  return `${trimmed}/v1`;
}

/** Header value for Anthropic 1M context beta */
export const ANTHROPIC_1M_CONTEXT_HEADER = "context-1m-2025-08-07";

/**
 * Build headers for Anthropic provider, optionally including the 1M context beta header.
 * Exported for testing.
 */
export function buildAnthropicHeaders(
  existingHeaders: Record<string, string> | undefined,
  use1MContext: boolean | undefined
): Record<string, string> | undefined {
  if (!use1MContext) {
    return existingHeaders;
  }
  if (existingHeaders) {
    return { ...existingHeaders, "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
  }
  return { "anthropic-beta": ANTHROPIC_1M_CONTEXT_HEADER };
}

/**
 * Build app attribution headers used by OpenRouter (and other compatible platforms).
 *
 * Attribution docs:
 * - OpenRouter: https://openrouter.ai/docs/app-attribution
 * - Vercel AI Gateway: https://vercel.com/docs/ai-gateway/app-attribution
 *
 * Exported for testing.
 */
export function buildAppAttributionHeaders(
  existingHeaders: Record<string, string> | undefined
): Record<string, string> {
  // Clone to avoid mutating caller-provided objects.
  const headers: Record<string, string> = existingHeaders ? { ...existingHeaders } : {};

  // Header names are case-insensitive. Preserve user-provided values by never overwriting.
  const existingLowercaseKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));

  if (!existingLowercaseKeys.has("http-referer")) {
    headers["HTTP-Referer"] = MUX_APP_ATTRIBUTION_URL;
  }

  if (!existingLowercaseKeys.has("x-title")) {
    headers["X-Title"] = MUX_APP_ATTRIBUTION_TITLE;
  }

  return headers;
}

/**
 * Preload AI SDK provider modules to avoid race conditions in concurrent test environments.
 * This function loads @ai-sdk/anthropic, @ai-sdk/openai, and ollama-ai-provider-v2 eagerly
 * so that subsequent dynamic imports in createModel() hit the module cache instead of racing.
 *
 * In production, providers are lazy-loaded on first use to optimize startup time.
 * In tests, we preload them once during setup to ensure reliable concurrent execution.
 */
export async function preloadAISDKProviders(): Promise<void> {
  // Preload providers to ensure they're in the module cache before concurrent tests run
  await Promise.all(Object.values(PROVIDER_REGISTRY).map((importFn) => importFn()));
}

/**
 * Parse provider and model ID from model string.
 * Handles model IDs with colons (e.g., "ollama:gpt-oss:20b").
 * Only splits on the first colon to support Ollama model naming convention.
 *
 * @param modelString - Model string in format "provider:model-id"
 * @returns Tuple of [providerName, modelId]
 * @example
 * parseModelString("anthropic:claude-opus-4") // ["anthropic", "claude-opus-4"]
 * parseModelString("ollama:gpt-oss:20b") // ["ollama", "gpt-oss:20b"]
 */
function parseModelString(modelString: string): [string, string] {
  const colonIndex = modelString.indexOf(":");
  const providerName = colonIndex !== -1 ? modelString.slice(0, colonIndex) : modelString;
  const modelId = colonIndex !== -1 ? modelString.slice(colonIndex + 1) : "";
  return [providerName, modelId];
}

function getTaskDepthFromConfig(
  config: ReturnType<Config["loadConfigOrDefault"]>,
  workspaceId: string
): number {
  const parentById = new Map<string, string | undefined>();
  for (const project of config.projects.values()) {
    for (const workspace of project.workspaces) {
      if (!workspace.id) continue;
      parentById.set(workspace.id, workspace.parentWorkspaceId);
    }
  }

  let depth = 0;
  let current = workspaceId;
  for (let i = 0; i < 32; i++) {
    const parent = parentById.get(current);
    if (!parent) break;
    depth += 1;
    current = parent;
  }

  if (depth >= 32) {
    throw new Error(
      `getTaskDepthFromConfig: possible parentWorkspaceId cycle starting at ${workspaceId}`
    );
  }

  return depth;
}

function cloneToolPreservingDescriptors(tool: Tool): Tool {
  assert(tool && typeof tool === "object", "tool must be an object");

  // Clone without invoking getters.
  const prototype = Object.getPrototypeOf(tool) as unknown;
  assert(
    prototype === null || typeof prototype === "object",
    "tool prototype must be an object or null"
  );

  const clone = Object.create(prototype) as object;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(tool));
  return clone as Tool;
}

function appendToolNote(existing: string | undefined, extra: string): string {
  if (!existing) {
    return extra;
  }

  return `${existing}\n\n${extra}`;
}

/**
 * Discover agent definitions for tool description context.
 *
 * The task tool lists "Available sub-agents" by filtering on
 * AgentDefinitionDescriptor.subagentRunnable.
 *
 * NOTE: discoverAgentDefinitions() sets descriptor.subagentRunnable from the agent's *own*
 * frontmatter only, which means derived agents (e.g. `base: exec`) may incorrectly appear
 * non-runnable if they don't repeat `subagent.runnable: true`.
 *
 * Re-resolve frontmatter with inheritance (base-first) so subagent.runnable is inherited.
 */
export async function discoverAvailableSubagentsForToolContext(args: {
  runtime: Parameters<typeof discoverAgentDefinitions>[0];
  workspacePath: string;
  cfg: ReturnType<Config["loadConfigOrDefault"]>;
  roots?: AgentDefinitionsRoots;
}): Promise<Awaited<ReturnType<typeof discoverAgentDefinitions>>> {
  assert(args, "discoverAvailableSubagentsForToolContext: args is required");
  assert(args.runtime, "discoverAvailableSubagentsForToolContext: runtime is required");
  assert(
    args.workspacePath && args.workspacePath.length > 0,
    "discoverAvailableSubagentsForToolContext: workspacePath is required"
  );
  assert(args.cfg, "discoverAvailableSubagentsForToolContext: cfg is required");

  const discovered = await discoverAgentDefinitions(args.runtime, args.workspacePath, {
    roots: args.roots,
  });

  const resolved = await Promise.all(
    discovered.map(async (descriptor) => {
      try {
        const resolvedFrontmatter = await resolveAgentFrontmatter(
          args.runtime,
          args.workspacePath,
          descriptor.id,
          { roots: args.roots }
        );

        const effectivelyDisabled = isAgentEffectivelyDisabled({
          cfg: args.cfg,
          agentId: descriptor.id,
          resolvedFrontmatter,
        });

        if (effectivelyDisabled) {
          return null;
        }

        return {
          ...descriptor,
          // Important: descriptor.subagentRunnable comes from the agent's own frontmatter only.
          // Re-resolve with inheritance so derived agents inherit runnable: true from their base.
          subagentRunnable: resolvedFrontmatter.subagent?.runnable ?? false,
        };
      } catch {
        // Best-effort: keep the descriptor if enablement or inheritance can't be resolved.
        return descriptor;
      }
    })
  );

  return resolved.filter((descriptor): descriptor is NonNullable<typeof descriptor> =>
    Boolean(descriptor)
  );
}

export class AIService extends EventEmitter {
  private readonly streamManager: StreamManager;
  private readonly historyService: HistoryService;
  private readonly partialService: PartialService;
  private readonly config: Config;
  private readonly providerService: ProviderService;
  private readonly workspaceMcpOverridesService: WorkspaceMcpOverridesService;
  private mcpServerManager?: MCPServerManager;
  private policyService?: PolicyService;
  private telemetryService?: TelemetryService;
  private readonly initStateManager: InitStateManager;
  private mockModeEnabled: boolean;
  private mockAiStreamPlayer?: MockAiStreamPlayer;
  private readonly backgroundProcessManager?: BackgroundProcessManager;
  private readonly sessionUsageService?: SessionUsageService;

  // Tracks in-flight stream startup (before StreamManager emits stream-start).
  // This enables user interrupts (Esc/Ctrl+C) during the UI "starting..." phase.
  private readonly pendingStreamStarts = new Map<
    string,
    { abortController: AbortController; startTime: number; syntheticMessageId: string }
  >();

  // Debug: captured LLM request payloads for last send per workspace
  private lastLlmRequestByWorkspace = new Map<string, DebugLlmRequestSnapshot>();
  private taskService?: TaskService;
  private extraTools?: Record<string, Tool>;

  constructor(
    config: Config,
    historyService: HistoryService,
    partialService: PartialService,
    initStateManager: InitStateManager,
    providerService: ProviderService,
    backgroundProcessManager?: BackgroundProcessManager,
    sessionUsageService?: SessionUsageService,
    workspaceMcpOverridesService?: WorkspaceMcpOverridesService
  ) {
    super();
    // Increase max listeners to accommodate multiple concurrent workspace listeners
    // Each workspace subscribes to stream events, and we expect >10 concurrent workspaces
    this.setMaxListeners(50);
    this.workspaceMcpOverridesService =
      workspaceMcpOverridesService ?? new WorkspaceMcpOverridesService(config);
    this.config = config;
    this.providerService = providerService;
    this.historyService = historyService;
    this.partialService = partialService;
    this.initStateManager = initStateManager;
    this.backgroundProcessManager = backgroundProcessManager;
    this.sessionUsageService = sessionUsageService;
    this.streamManager = new StreamManager(historyService, partialService, sessionUsageService);
    void this.ensureSessionsDir();
    this.setupStreamEventForwarding();
    this.mockModeEnabled = false;

    if (process.env.MUX_MOCK_AI === "1") {
      log.info("AIService running in MUX_MOCK_AI mode");
      this.enableMockMode();
    }
  }

  setPolicyService(service: PolicyService): void {
    this.policyService = service;
  }
  setTelemetryService(service: TelemetryService): void {
    this.telemetryService = service;
  }
  setMCPServerManager(manager: MCPServerManager): void {
    this.mcpServerManager = manager;
    this.streamManager.setMCPServerManager(manager);
  }

  setTaskService(taskService: TaskService): void {
    this.taskService = taskService;
  }

  /**
   * Set extra tools to include in every tool call.
   * Used by CLI to inject tools like set_exit_code without modifying core tool definitions.
   */
  setExtraTools(tools: Record<string, Tool>): void {
    this.extraTools = tools;
  }

  /**
   * Forward all stream events from StreamManager to AIService consumers
   */
  private setupStreamEventForwarding(): void {
    this.streamManager.on("stream-start", (data) => this.emit("stream-start", data));
    this.streamManager.on("stream-delta", (data) => this.emit("stream-delta", data));
    this.streamManager.on("stream-end", (data: StreamEndEvent) => {
      // Best-effort capture of the provider response for the "Last LLM request" debug modal.
      // Must never break live streaming.
      try {
        const snapshot = this.lastLlmRequestByWorkspace.get(data.workspaceId);
        if (snapshot) {
          // If messageId is missing (legacy fixtures), attach anyway.
          const shouldAttach = snapshot.messageId === data.messageId || snapshot.messageId == null;
          if (shouldAttach) {
            const updated: DebugLlmRequestSnapshot = {
              ...snapshot,
              response: {
                capturedAt: Date.now(),
                metadata: data.metadata,
                parts: data.parts,
              },
            };

            const cloned =
              typeof structuredClone === "function"
                ? structuredClone(updated)
                : (JSON.parse(JSON.stringify(updated)) as DebugLlmRequestSnapshot);

            this.lastLlmRequestByWorkspace.set(data.workspaceId, cloned);
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.warn("Failed to capture debug LLM response snapshot", { error: errMsg });
      }

      this.emit("stream-end", data);
    });

    // Handle stream-abort: dispose of partial based on abandonPartial flag
    this.streamManager.on("stream-abort", (data: StreamAbortEvent) => {
      void (async () => {
        if (data.abandonPartial) {
          // Caller requested discarding partial - delete without committing
          await this.partialService.deletePartial(data.workspaceId);
        } else {
          // Commit interrupted message to history with partial:true metadata
          // This ensures /clear and /truncate can clean up interrupted messages
          const partial = await this.partialService.readPartial(data.workspaceId);
          if (partial) {
            await this.partialService.commitToHistory(data.workspaceId);
            await this.partialService.deletePartial(data.workspaceId);
          }
        }

        // Forward abort event to consumers
        this.emit("stream-abort", data);
      })();
    });

    this.streamManager.on("error", (data) => this.emit("error", data));
    // Forward tool events
    this.streamManager.on("tool-call-start", (data) => this.emit("tool-call-start", data));
    this.streamManager.on("tool-call-delta", (data) => this.emit("tool-call-delta", data));
    this.streamManager.on("tool-call-end", (data) => this.emit("tool-call-end", data));
    // Forward reasoning events
    this.streamManager.on("reasoning-delta", (data) => this.emit("reasoning-delta", data));
    this.streamManager.on("reasoning-end", (data) => this.emit("reasoning-end", data));
    this.streamManager.on("usage-delta", (data) => this.emit("usage-delta", data));
  }

  private async ensureSessionsDir(): Promise<void> {
    try {
      await fs.mkdir(this.config.sessionsDir, { recursive: true });
    } catch (error) {
      log.error("Failed to create sessions directory:", error);
    }
  }

  isMockModeEnabled(): boolean {
    return this.mockModeEnabled;
  }

  releaseMockStreamStartGate(workspaceId: string): void {
    this.mockAiStreamPlayer?.releaseStreamStartGate(workspaceId);
  }

  enableMockMode(): void {
    this.mockModeEnabled = true;

    this.mockAiStreamPlayer ??= new MockAiStreamPlayer({
      aiService: this,
      historyService: this.historyService,
    });
  }

  async getWorkspaceMetadata(workspaceId: string): Promise<Result<WorkspaceMetadata>> {
    try {
      // Read from config.json (single source of truth)
      // getAllWorkspaceMetadata() handles migration from legacy metadata.json files
      const allMetadata = await this.config.getAllWorkspaceMetadata();
      const metadata = allMetadata.find((m) => m.id === workspaceId);

      if (!metadata) {
        return Err(
          `Workspace metadata not found for ${workspaceId}. Workspace may not be properly initialized.`
        );
      }

      return Ok(metadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to read workspace metadata: ${message}`);
    }
  }

  /**
   * Split assistant messages that have text after tool calls with results.

  /**
   * Create an AI SDK model from a model string (e.g., "anthropic:claude-opus-4-1")
   *
   * IMPORTANT: We ONLY use providers.jsonc as the single source of truth for provider configuration.
   * We DO NOT use environment variables or default constructors that might read them.
   * This ensures consistent, predictable configuration management.
   *
   * Provider configuration from providers.jsonc is passed verbatim to the provider
   * constructor, ensuring automatic parity with Vercel AI SDK - any configuration options
   * supported by the provider will work without modification.
   */
  async createModel(
    modelString: string,
    muxProviderOptions?: MuxProviderOptions
  ): Promise<Result<LanguageModel, SendMessageError>> {
    try {
      // Parse model string (format: "provider:model-id")
      // Parse provider and model ID from model string
      const [providerName, modelId] = parseModelString(modelString);

      if (!providerName || !modelId) {
        return Err({
          type: "invalid_model_string",
          message: `Invalid model string format: "${modelString}". Expected "provider:model-id"`,
        });
      }

      // Check if provider is supported (prevents silent failures when adding to PROVIDER_REGISTRY
      // but forgetting to implement handler below)
      if (!(providerName in PROVIDER_REGISTRY)) {
        return Err({
          type: "provider_not_supported",
          provider: providerName,
        });
      }

      if (this.policyService?.isEnforced()) {
        const provider = providerName as ProviderName;
        if (!this.policyService.isProviderAllowed(provider)) {
          return Err({
            type: "policy_denied",
            message: `Provider ${providerName} is not allowed by policy`,
          });
        }

        if (!this.policyService.isModelAllowed(provider, modelId)) {
          return Err({
            type: "policy_denied",
            message: `Model ${providerName}:${modelId} is not allowed by policy`,
          });
        }
      }

      // Load providers configuration - the ONLY source of truth
      const providersConfig = this.config.loadProvidersConfig();
      let providerConfig = providersConfig?.[providerName] ?? {};

      // Map baseUrl to baseURL if present (SDK expects baseURL)
      const { baseUrl, ...configWithoutBaseUrl } = providerConfig;
      providerConfig = baseUrl
        ? { ...configWithoutBaseUrl, baseURL: baseUrl }
        : configWithoutBaseUrl;

      // Policy: force provider base URL (if configured).
      const forcedBaseUrl = this.policyService?.isEnforced()
        ? this.policyService.getForcedBaseUrl(providerName as ProviderName)
        : undefined;
      if (forcedBaseUrl) {
        providerConfig = { ...providerConfig, baseURL: forcedBaseUrl };
      }

      // Inject app attribution headers (used by OpenRouter and other compatible platforms).
      // We never overwrite user-provided values (case-insensitive header matching).
      providerConfig = {
        ...providerConfig,
        headers: buildAppAttributionHeaders(providerConfig.headers),
      };

      // Handle Anthropic provider
      if (providerName === "anthropic") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("anthropic", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Build config with resolved credentials
        const configWithApiKey = creds.apiKey
          ? { ...providerConfig, apiKey: creds.apiKey }
          : providerConfig;

        // Normalize base URL to ensure /v1 suffix (SDK expects it)
        const effectiveBaseURL = configWithApiKey.baseURL ?? creds.baseUrl?.trim();
        const normalizedConfig = effectiveBaseURL
          ? { ...configWithApiKey, baseURL: normalizeAnthropicBaseURL(effectiveBaseURL) }
          : configWithApiKey;

        // Add 1M context beta header if requested
        const headers = buildAnthropicHeaders(
          normalizedConfig.headers,
          muxProviderOptions?.anthropic?.use1MContext
        );

        // Lazy-load Anthropic provider to reduce startup time
        const { createAnthropic } = await PROVIDER_REGISTRY.anthropic();
        // Wrap fetch to inject cache_control on tools and messages
        // (SDK doesn't translate providerOptions to cache_control for these)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const fetchWithCacheControl = wrapFetchWithAnthropicCacheControl(baseFetch);
        const provider = createAnthropic({
          ...normalizedConfig,
          headers,
          fetch: fetchWithCacheControl,
        });
        return Ok(provider(modelId));
      }

      // Handle OpenAI provider (using Responses API)
      if (providerName === "openai") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("openai", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Merge resolved credentials into config
        const configWithCreds = {
          ...providerConfig,
          apiKey: creds.apiKey,
          ...(creds.baseUrl && !providerConfig.baseURL && { baseURL: creds.baseUrl }),
          ...(creds.organization && { organization: creds.organization }),
        };

        // Extract serviceTier from config to pass through to buildProviderOptions
        const configServiceTier = providerConfig.serviceTier as string | undefined;
        if (configServiceTier && muxProviderOptions) {
          muxProviderOptions.openai = {
            ...muxProviderOptions.openai,
            serviceTier: configServiceTier as "auto" | "default" | "flex" | "priority",
          };
        }

        const baseFetch = getProviderFetch(providerConfig);

        // Wrap fetch to default truncation to "disabled" for OpenAI Responses API calls.
        // This preserves our compaction handling while still allowing explicit truncation (e.g., auto).
        const fetchWithOpenAITruncation = Object.assign(
          async (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1]
          ): Promise<Response> => {
            try {
              const urlString = (() => {
                if (typeof input === "string") {
                  return input;
                }
                if (input instanceof URL) {
                  return input.toString();
                }
                if (typeof input === "object" && input !== null && "url" in input) {
                  const possibleUrl = (input as { url?: unknown }).url;
                  if (typeof possibleUrl === "string") {
                    return possibleUrl;
                  }
                }
                return "";
              })();

              const method = (init?.method ?? "GET").toUpperCase();
              const isOpenAIResponses = /\/v1\/responses(\?|$)/.test(urlString);

              const body = init?.body;
              if (isOpenAIResponses && method === "POST" && typeof body === "string") {
                // Clone headers to avoid mutating caller-provided objects
                const headers = new Headers(init?.headers);
                // Remove content-length if present, since body will change
                headers.delete("content-length");

                try {
                  const json = JSON.parse(body) as Record<string, unknown>;
                  const truncation = json.truncation;
                  if (truncation !== "auto" && truncation !== "disabled") {
                    json.truncation = "disabled";
                  }
                  const newBody = JSON.stringify(json);
                  const newInit: RequestInit = { ...init, headers, body: newBody };
                  return baseFetch(input, newInit);
                } catch {
                  // If body isn't JSON, fall through to normal fetch
                  return baseFetch(input, init);
                }
              }

              // Default passthrough
              return baseFetch(input, init);
            } catch {
              // On any unexpected error, fall back to original fetch
              return baseFetch(input, init);
            }
          },
          "preconnect" in baseFetch && typeof baseFetch.preconnect === "function"
            ? {
                preconnect: baseFetch.preconnect.bind(baseFetch),
              }
            : {}
        );

        // Lazy-load OpenAI provider to reduce startup time
        const { createOpenAI } = await PROVIDER_REGISTRY.openai();
        const provider = createOpenAI({
          ...configWithCreds,
          // Cast is safe: our fetch implementation is compatible with the SDK's fetch type.
          // The preconnect method is optional in our implementation but required by the SDK type.
          fetch: fetchWithOpenAITruncation as typeof fetch,
        });
        // Use Responses API for persistence and built-in tools
        // OpenAI manages reasoning state via previousResponseId - no middleware needed
        const model = provider.responses(modelId);
        return Ok(model);
      }

      // Handle xAI provider
      if (providerName === "xai") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("xai", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        const baseFetch = getProviderFetch(providerConfig);
        const { apiKey: _apiKey, baseURL, headers, ...extraOptions } = providerConfig;

        const { searchParameters, ...restOptions } = extraOptions as {
          searchParameters?: Record<string, unknown>;
        } & Record<string, unknown>;

        if (searchParameters && muxProviderOptions) {
          const existingXaiOverrides = muxProviderOptions.xai ?? {};
          muxProviderOptions.xai = {
            ...existingXaiOverrides,
            searchParameters:
              existingXaiOverrides.searchParameters ??
              (searchParameters as XaiProviderOptions["searchParameters"]),
          };
        }

        const { createXai } = await PROVIDER_REGISTRY.xai();
        const provider = createXai({
          apiKey: creds.apiKey,
          baseURL: creds.baseUrl ?? baseURL,
          headers,
          ...restOptions,
          fetch: baseFetch,
        });
        return Ok(provider(modelId));
      }

      // Handle Ollama provider
      if (providerName === "ollama") {
        // Ollama doesn't require API key - it's a local service
        const baseFetch = getProviderFetch(providerConfig);

        // Lazy-load Ollama provider to reduce startup time
        const { createOllama } = await PROVIDER_REGISTRY.ollama();
        const provider = createOllama({
          ...providerConfig,
          fetch: baseFetch,
          // Use strict mode for better compatibility with Ollama API
          compatibility: "strict",
        });
        return Ok(provider(modelId));
      }

      // Handle OpenRouter provider
      if (providerName === "openrouter") {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials("openrouter", providerConfig);
        if (!creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const baseFetch = getProviderFetch(providerConfig);

        // Extract standard provider settings (apiKey, baseUrl, headers, fetch)
        const {
          apiKey: _apiKey,
          baseUrl,
          headers,
          fetch: _fetch,
          ...extraOptions
        } = providerConfig;

        // OpenRouter routing options that need to be nested under "provider" in API request
        // See: https://openrouter.ai/docs/features/provider-routing
        const OPENROUTER_ROUTING_OPTIONS = [
          "order",
          "allow_fallbacks",
          "only",
          "ignore",
          "require_parameters",
          "data_collection",
          "sort",
          "quantizations",
        ];

        // Build extraBody: routing options go under "provider", others stay at root
        const routingOptions: Record<string, unknown> = {};
        const otherOptions: Record<string, unknown> = {};

        for (const [key, value] of Object.entries(extraOptions)) {
          if (OPENROUTER_ROUTING_OPTIONS.includes(key)) {
            routingOptions[key] = value;
          } else {
            otherOptions[key] = value;
          }
        }

        // Build extraBody with provider nesting if routing options exist
        let extraBody: Record<string, unknown> | undefined;
        if (Object.keys(routingOptions).length > 0) {
          extraBody = { provider: routingOptions, ...otherOptions };
        } else if (Object.keys(otherOptions).length > 0) {
          extraBody = otherOptions;
        }

        // Lazy-load OpenRouter provider to reduce startup time
        const { createOpenRouter } = await PROVIDER_REGISTRY.openrouter();
        const provider = createOpenRouter({
          apiKey: creds.apiKey,
          baseURL: creds.baseUrl ?? baseUrl,
          headers,
          fetch: baseFetch,
          extraBody,
        });
        return Ok(provider(modelId));
      }

      // Handle Amazon Bedrock provider
      if (providerName === "bedrock") {
        // Resolve region from config + env (single source of truth)
        const creds = resolveProviderCredentials("bedrock", providerConfig);
        if (!creds.isConfigured || !creds.region) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const { region } = creds;

        // Optional AWS shared config profile name (equivalent to AWS_PROFILE).
        // Useful for SSO profiles when Mux isn't launched with AWS_PROFILE set.
        const profile =
          typeof providerConfig.profile === "string" && providerConfig.profile.trim()
            ? providerConfig.profile.trim()
            : undefined;

        const baseFetch = getProviderFetch(providerConfig);
        const { createAmazonBedrock } = await PROVIDER_REGISTRY.bedrock();

        // Check if explicit credentials are provided in config
        const hasExplicitCredentials = providerConfig.accessKeyId && providerConfig.secretAccessKey;

        if (hasExplicitCredentials) {
          // Use explicit credentials from providers.jsonc
          const provider = createAmazonBedrock({
            ...providerConfig,
            region,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Check for Bedrock bearer token (simplest auth) - from config or environment
        // The SDK's apiKey option maps to AWS_BEARER_TOKEN_BEDROCK
        const bearerToken =
          typeof providerConfig.bearerToken === "string" ? providerConfig.bearerToken : undefined;

        if (bearerToken) {
          const provider = createAmazonBedrock({
            region,
            apiKey: bearerToken,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Check if AWS_BEARER_TOKEN_BEDROCK env var is set
        if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
          // SDK automatically picks this up via apiKey option
          const provider = createAmazonBedrock({
            region,
            fetch: baseFetch,
          });
          return Ok(provider(modelId));
        }

        // Use AWS credential provider chain for flexible authentication:
        // - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
        // - Shared credentials file (~/.aws/credentials)
        // - EC2 instance profiles
        // - ECS task roles
        // - EKS service account (IRSA)
        // - SSO credentials
        // - And more...
        const provider = createAmazonBedrock({
          region,
          credentialProvider: fromNodeProviderChain(profile ? { profile } : {}),
          fetch: baseFetch,
        });
        return Ok(provider(modelId));
      }

      // Handle Mux Gateway provider
      if (providerName === "mux-gateway") {
        // Resolve couponCode from config (single source of truth)
        const creds = resolveProviderCredentials("mux-gateway", providerConfig);
        if (!creds.isConfigured || !creds.couponCode) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }
        const { couponCode } = creds;

        const { createGateway } = await PROVIDER_REGISTRY["mux-gateway"]();
        // For Anthropic models via gateway, wrap fetch to inject cache_control on tools
        // (gateway provider doesn't process providerOptions.anthropic.cacheControl)
        // Use getProviderFetch to preserve any user-configured custom fetch (e.g., proxies)
        const baseFetch = getProviderFetch(providerConfig);
        const isAnthropicModel = modelId.startsWith("anthropic/");
        const fetchWithCacheControl = isAnthropicModel
          ? wrapFetchWithAnthropicCacheControl(baseFetch)
          : baseFetch;
        const fetchWithAutoLogout = wrapFetchWithMuxGatewayAutoLogout(
          fetchWithCacheControl,
          this.providerService
        );
        // Use configured baseURL or fall back to default gateway URL
        const gatewayBaseURL =
          providerConfig.baseURL ?? "https://gateway.mux.coder.com/api/v1/ai-gateway/v1/ai";
        const gateway = createGateway({
          apiKey: couponCode,
          baseURL: gatewayBaseURL,
          fetch: fetchWithAutoLogout,
        });
        return Ok(gateway(modelId));
      }

      // Generic handler for simple providers (standard API key + factory pattern)
      // Providers with custom logic (anthropic, openai, xai, ollama, openrouter, bedrock, mux-gateway)
      // are handled explicitly above. New providers using the standard pattern need only be
      // added to PROVIDER_DEFINITIONS - no code changes required here.
      const providerDef = PROVIDER_DEFINITIONS[providerName as ProviderName];
      if (providerDef) {
        // Resolve credentials from config + env (single source of truth)
        const creds = resolveProviderCredentials(providerName as ProviderName, providerConfig);
        if (providerDef.requiresApiKey && !creds.isConfigured) {
          return Err({ type: "api_key_not_found", provider: providerName });
        }

        // Lazy-load and create provider using factoryName from definition
        const providerModule = (await providerDef.import()) as unknown as Record<
          string,
          (config: Record<string, unknown>) => (modelId: string) => LanguageModel
        >;
        const factory = providerModule[providerDef.factoryName];
        if (!factory) {
          return Err({
            type: "provider_not_supported",
            provider: providerName,
          });
        }

        // Merge resolved credentials into config
        const configWithCreds = {
          ...providerConfig,
          ...(creds.apiKey && { apiKey: creds.apiKey }),
          ...(creds.baseUrl && !providerConfig.baseURL && { baseURL: creds.baseUrl }),
        };

        const provider = factory({
          ...configWithCreds,
          fetch: getProviderFetch(providerConfig),
        });
        return Ok(provider(modelId));
      }

      return Err({
        type: "provider_not_supported",
        provider: providerName,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return Err({ type: "unknown", raw: `Failed to create model: ${errorMessage}` });
    }
  }

  private resolveGatewayModelString(
    modelString: string,
    modelKey?: string,
    explicitlyRequestedGateway = false
  ): string {
    // Backend-authoritative routing avoids frontend localStorage races (issue #1769).
    const canonicalModelString = normalizeGatewayModel(modelString);
    const normalizedModelKey = modelKey ? normalizeGatewayModel(modelKey) : canonicalModelString;
    const [providerName, modelId] = parseModelString(canonicalModelString);

    if (!providerName || !modelId) {
      return canonicalModelString;
    }

    if (providerName === "mux-gateway" || !(providerName in PROVIDER_REGISTRY)) {
      return canonicalModelString;
    }

    const typedProvider = providerName as ProviderName;
    if (!MUX_GATEWAY_SUPPORTED_PROVIDERS.has(typedProvider)) {
      return canonicalModelString;
    }

    const config = this.config.loadConfigOrDefault();
    const gatewayEnabled = config.muxGatewayEnabled !== false;
    const gatewayModels = config.muxGatewayModels ?? [];
    // Legacy clients may still send mux-gateway model IDs before the backend config
    // has synchronized their allowlist, so honor an explicit mux-gateway prefix as
    // an implicit opt-in to avoid first-message API key failures.
    const isGatewayModelEnabled =
      explicitlyRequestedGateway ||
      gatewayModels.includes(canonicalModelString) ||
      gatewayModels.includes(normalizedModelKey);

    if (!gatewayEnabled || !isGatewayModelEnabled) {
      return canonicalModelString;
    }

    const providersConfig = this.config.loadProvidersConfig() ?? {};
    const gatewayConfig = providersConfig["mux-gateway"] ?? {};
    const gatewayConfigured = resolveProviderCredentials("mux-gateway", gatewayConfig).isConfigured;

    if (!gatewayConfigured) {
      return canonicalModelString;
    }

    return `mux-gateway:${providerName}/${modelId}`;
  }

  /**
   * Stream a message conversation to the AI model
   * @param messages Array of conversation messages
   * @param workspaceId Unique identifier for the workspace
   * @param modelString Model string (e.g., "anthropic:claude-opus-4-1") - required from frontend
   * @param thinkingLevel Optional thinking/reasoning level for AI models
   * @param toolPolicy Optional policy to filter available tools
   * @param abortSignal Optional signal to abort the stream
   * @param additionalSystemInstructions Optional additional system instructions to append
   * @param maxOutputTokens Optional maximum tokens for model output
   * @param muxProviderOptions Optional provider-specific options
   * @param agentId Optional agent id - determines tool policy and plan-file behavior
   * @param recordFileState Optional callback to record file state for external edit detection
   * @param changedFileAttachments Optional attachments for files that were edited externally
   * @param postCompactionAttachments Optional attachments to inject after compaction
   * @param disableWorkspaceAgents When true, read agent definitions from project path instead of workspace worktree
   * @param openaiTruncationModeOverride Optional OpenAI truncation override (e.g., compaction retry)
   * @returns Promise that resolves when streaming completes or fails
   */
  async streamMessage(
    messages: MuxMessage[],
    workspaceId: string,
    modelString: string,
    thinkingLevel?: ThinkingLevel,
    toolPolicy?: ToolPolicy,
    abortSignal?: AbortSignal,
    additionalSystemInstructions?: string,
    maxOutputTokens?: number,
    muxProviderOptions?: MuxProviderOptions,
    agentId?: string,
    recordFileState?: (filePath: string, state: FileState) => void,
    changedFileAttachments?: EditedFileAttachment[],
    postCompactionAttachments?: PostCompactionAttachment[] | null,
    experiments?: SendMessageOptions["experiments"],
    system1Model?: string,
    system1ThinkingLevel?: ThinkingLevel,
    disableWorkspaceAgents?: boolean,
    hasQueuedMessage?: () => boolean,
    openaiTruncationModeOverride?: "auto" | "disabled"
  ): Promise<Result<void, SendMessageError>> {
    // Support interrupts during startup (before StreamManager emits stream-start).
    // We register an AbortController up-front and let stopStream() abort it.
    const pendingAbortController = new AbortController();
    const startTime = Date.now();
    const syntheticMessageId = `starting-${startTime}-${Math.random().toString(36).substring(2, 11)}`;

    // Link external abort signal (if provided).
    const unlinkAbortSignal = linkAbortSignal(abortSignal, pendingAbortController);

    this.pendingStreamStarts.set(workspaceId, {
      abortController: pendingAbortController,
      startTime,
      syntheticMessageId,
    });

    const combinedAbortSignal = pendingAbortController.signal;

    try {
      if (this.mockModeEnabled && this.mockAiStreamPlayer) {
        await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
        if (combinedAbortSignal.aborted) {
          return Ok(undefined);
        }
        return await this.mockAiStreamPlayer.play(messages, workspaceId, {
          model: modelString,
          abortSignal: combinedAbortSignal,
        });
      }

      // DEBUG: Log streamMessage call
      const lastMessage = messages[messages.length - 1];
      log.debug(
        `[STREAM MESSAGE] workspaceId=${workspaceId} messageCount=${messages.length} lastRole=${lastMessage?.role}`
      );

      // Before starting a new stream, commit any existing partial to history
      // This is idempotent - won't double-commit if already in chat.jsonl
      await this.partialService.commitToHistory(workspaceId);

      // Mode (plan|exec|compact) is derived from the selected agent definition.
      const effectiveMuxProviderOptions: MuxProviderOptions = muxProviderOptions ?? {};
      const effectiveThinkingLevel: ThinkingLevel = thinkingLevel ?? "off";

      // For xAI models, swap between reasoning and non-reasoning variants based on thinking level
      // Similar to how OpenAI handles reasoning vs non-reasoning models
      const explicitlyRequestedGateway = modelString.trim().startsWith("mux-gateway:");
      const canonicalModelString = normalizeGatewayModel(modelString);
      let effectiveModelString = canonicalModelString;
      const [canonicalProviderName, canonicalModelId] = parseModelString(canonicalModelString);
      if (canonicalProviderName === "xai" && canonicalModelId === "grok-4-1-fast") {
        // xAI Grok only supports full reasoning (no medium/low)
        // Map to appropriate variant based on thinking level
        const variant =
          effectiveThinkingLevel !== "off"
            ? "grok-4-1-fast-reasoning"
            : "grok-4-1-fast-non-reasoning";
        effectiveModelString = `xai:${variant}`;
        log.debug("Mapping xAI Grok model to variant", {
          original: modelString,
          effective: effectiveModelString,
          thinkingLevel: effectiveThinkingLevel,
        });
      }

      effectiveModelString = this.resolveGatewayModelString(
        effectiveModelString,
        canonicalModelString,
        explicitlyRequestedGateway
      );

      const routedThroughGateway = effectiveModelString.startsWith("mux-gateway:");

      // Create model instance with early API key validation
      const modelResult = await this.createModel(effectiveModelString, effectiveMuxProviderOptions);
      if (!modelResult.success) {
        return Err(modelResult.error);
      }

      // Dump original messages for debugging
      log.debug_obj(`${workspaceId}/1_original_messages.json`, messages);

      // Normalize provider for provider-specific handling (Mux Gateway models should behave
      // like their underlying provider for message transforms and compliance checks).
      const providerForMessages = canonicalProviderName;

      // Tool names are needed for the mode transition sentinel injection.
      // Compute them once we know the effective agent + tool policy.
      let toolNamesForSentinel: string[] = [];

      // Filter out assistant messages with only reasoning (no text/tools)
      // EXCEPTION: When extended thinking is enabled, preserve reasoning-only messages
      // to comply with Extended Thinking API requirements
      const preserveReasoningOnly =
        providerForMessages === "anthropic" && effectiveThinkingLevel !== "off";
      const filteredMessages = filterEmptyAssistantMessages(messages, preserveReasoningOnly);
      log.debug(`Filtered ${messages.length - filteredMessages.length} empty assistant messages`);
      log.debug_obj(`${workspaceId}/1a_filtered_messages.json`, filteredMessages);

      // OpenAI-specific: Keep reasoning parts in history
      // OpenAI manages conversation state via previousResponseId
      if (providerForMessages === "openai") {
        log.debug("Keeping reasoning parts for OpenAI (managed via previousResponseId)");
      }

      // Add [CONTINUE] sentinel to partial messages (for model context)
      const messagesWithSentinel = addInterruptedSentinel(filteredMessages);

      // Note: Further message processing (mode transition, file changes, etc.) happens
      // after runtime is created below, as we need runtime to read the plan file

      // Get workspace metadata to retrieve workspace path
      const metadataResult = await this.getWorkspaceMetadata(workspaceId);
      if (!metadataResult.success) {
        return Err({ type: "unknown", raw: metadataResult.error });
      }

      const metadata = metadataResult.data;

      if (this.policyService?.isEnforced()) {
        if (!this.policyService.isRuntimeAllowed(metadata.runtimeConfig)) {
          return Err({
            type: "policy_denied",
            message: "Workspace runtime is not allowed by policy",
          });
        }
      }
      const workspaceLog = log.withFields({ workspaceId, workspaceName: metadata.name });

      // Get actual workspace path from config (handles both legacy and new format)
      const workspace = this.config.findWorkspace(workspaceId);
      if (!workspace) {
        return Err({ type: "unknown", raw: `Workspace ${workspaceId} not found in config` });
      }

      // Get workspace path - handle both worktree and in-place modes
      const runtime = createRuntime(metadata.runtimeConfig, {
        projectPath: metadata.projectPath,
        workspaceName: metadata.name,
      });
      // In-place workspaces (CLI/benchmarks) have projectPath === name
      // Use path directly instead of reconstructing via getWorkspacePath
      const isInPlace = metadata.projectPath === metadata.name;
      const workspacePath = isInPlace
        ? metadata.projectPath
        : runtime.getWorkspacePath(metadata.projectPath, metadata.name);

      // Wait for init to complete before any runtime I/O operations
      // (SSH/devcontainer may not be ready until init finishes pulling the container)
      await this.initStateManager.waitForInit(workspaceId, combinedAbortSignal);
      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }

      // Verify runtime is actually reachable after init completes.
      // For Docker workspaces, this checks the container exists and starts it if stopped.
      // For Coder workspaces, this may start a stopped workspace and wait for it.
      // If init failed during container creation, ensureReady() will return an error.
      const readyResult = await runtime.ensureReady({
        signal: combinedAbortSignal,
        statusSink: (status) => {
          // Emit runtime-status events for frontend UX (StreamingBarrier)
          this.emit("runtime-status", {
            type: "runtime-status",
            workspaceId,
            phase: status.phase,
            runtimeType: status.runtimeType,
            detail: status.detail,
          });
        },
      });
      if (!readyResult.ready) {
        // Generate message ID for the error event (frontend needs this for synthetic message)
        const errorMessageId = createAssistantMessageId();
        const runtimeType = metadata.runtimeConfig?.type ?? "local";
        const runtimeLabel = runtimeType === "docker" ? "Container" : "Runtime";
        const errorMessage = readyResult.error || `${runtimeLabel} unavailable.`;

        // Use the errorType from ensureReady result (runtime_not_ready vs runtime_start_failed)
        const errorType = readyResult.errorType;

        // Emit error event so frontend receives it via stream subscription.
        // This mirrors the context_exceeded pattern - the fire-and-forget sendMessage
        // call in useCreationWorkspace.ts won't see the returned Err, but will receive
        // this event through the workspace chat subscription.
        this.emit(
          "error",
          createErrorEvent(workspaceId, {
            messageId: errorMessageId,
            error: errorMessage,
            errorType,
          })
        );

        return Err({
          type: errorType,
          message: errorMessage,
        });
      }

      // Resolve the active agent definition.
      //
      // Precedence:
      // - Child workspaces (tasks) use their persisted agentId/agentType.
      // - Main workspaces use the requested agentId (frontend), falling back to exec.
      const requestedAgentIdRaw =
        workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
          ? MUX_HELP_CHAT_AGENT_ID
          : ((metadata.parentWorkspaceId ? (metadata.agentId ?? metadata.agentType) : undefined) ??
            (typeof agentId === "string" ? agentId : undefined) ??
            "exec");
      const requestedAgentIdNormalized = requestedAgentIdRaw.trim().toLowerCase();
      const parsedAgentId = AgentIdSchema.safeParse(requestedAgentIdNormalized);
      const requestedAgentId = parsedAgentId.success ? parsedAgentId.data : ("exec" as const);
      let effectiveAgentId = requestedAgentId;

      // When disableWorkspaceAgents is true, skip workspace-specific agents entirely.
      // Use project path so only built-in/global agents are available. This allows "unbricking"
      // when iterating on agent files - a broken agent in the worktree won't affect message sending.
      const agentDiscoveryPath = disableWorkspaceAgents ? metadata.projectPath : workspacePath;

      const cfg = this.config.loadConfigOrDefault();
      const isSubagentWorkspace = Boolean(metadata.parentWorkspaceId);

      let agentDefinition;
      try {
        agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, effectiveAgentId);
      } catch (error) {
        workspaceLog.warn("Failed to load agent definition; falling back to exec", {
          effectiveAgentId,
          agentDiscoveryPath,
          disableWorkspaceAgents,
          error: error instanceof Error ? error.message : String(error),
        });
        agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
      }

      // Keep agent ID aligned with the actual definition used (may fall back to exec).
      effectiveAgentId = agentDefinition.id;
      // Enforce per-agent enablement for sub-agent workspaces (tasks).
      //
      // Disabled agents should never run as sub-agents, even if a task workspace already exists
      // on disk (e.g., config changed since creation).
      //
      // For top-level workspaces, fall back to exec to keep the workspace usable.
      if (agentDefinition.id !== "exec") {
        try {
          const resolvedFrontmatter = await resolveAgentFrontmatter(
            runtime,
            agentDiscoveryPath,
            agentDefinition.id
          );

          const effectivelyDisabled = isAgentEffectivelyDisabled({
            cfg,
            agentId: agentDefinition.id,
            resolvedFrontmatter,
          });

          if (effectivelyDisabled) {
            const errorMessage = `Agent '${agentDefinition.id}' is disabled.`;

            if (isSubagentWorkspace) {
              const errorMessageId = createAssistantMessageId();
              this.emit(
                "error",
                createErrorEvent(workspaceId, {
                  messageId: errorMessageId,
                  error: errorMessage,
                  errorType: "unknown",
                })
              );
              return Err({ type: "unknown", raw: errorMessage });
            }

            workspaceLog.warn("Selected agent is disabled; falling back to exec", {
              agentId: agentDefinition.id,
              requestedAgentId,
            });
            agentDefinition = await readAgentDefinition(runtime, agentDiscoveryPath, "exec");
            effectiveAgentId = agentDefinition.id;
          }
        } catch (error: unknown) {
          // Best-effort only - do not fail a stream due to disablement resolution.
          workspaceLog.debug("Failed to resolve agent enablement; continuing", {
            agentId: agentDefinition.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Determine if agent is plan-like by checking if propose_plan is in its resolved tools
      // (including inherited tools from base agents).
      const agentsForInheritance = await resolveAgentInheritanceChain({
        runtime,
        workspacePath: agentDiscoveryPath,
        agentId: agentDefinition.id,
        agentDefinition,
        workspaceId,
      });

      const agentIsPlanLike = isPlanLikeInResolvedChain(agentsForInheritance);
      const effectiveMode =
        agentDefinition.id === "compact" ? "compact" : agentIsPlanLike ? "plan" : "exec";

      const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
      const taskDepth = getTaskDepthFromConfig(cfg, workspaceId);
      const shouldDisableTaskToolsForDepth = taskDepth >= taskSettings.maxTaskNestingDepth;

      // NOTE: Caller-supplied policy is applied AFTER agent tool policy so callers can
      // further restrict the tool set (e.g., disable all tools for testing).
      // Agent policy establishes baseline (deny-all + enable whitelist + runtime restrictions).
      // Caller policy then narrows further if needed.
      const agentToolPolicy = resolveToolPolicyForAgent({
        agents: agentsForInheritance,
        isSubagent: isSubagentWorkspace,
        disableTaskToolsForDepth: shouldDisableTaskToolsForDepth,
      });

      // The Chat with Mux system workspace must remain sandboxed regardless of caller-supplied
      // toolPolicy (defense-in-depth).
      const systemWorkspaceToolPolicy: ToolPolicy | undefined =
        workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
          ? [
              { regex_match: ".*", action: "disable" },

              // Allow docs lookup via built-in skills (e.g. mux-docs), while keeping
              // filesystem/binary execution locked down.
              { regex_match: "agent_skill_read", action: "enable" },
              { regex_match: "agent_skill_read_file", action: "enable" },

              { regex_match: "mux_global_agents_read", action: "enable" },
              { regex_match: "mux_global_agents_write", action: "enable" },
              { regex_match: "ask_user_question", action: "enable" },
              { regex_match: "todo_read", action: "enable" },
              { regex_match: "todo_write", action: "enable" },
              { regex_match: "status_set", action: "enable" },
              { regex_match: "notify", action: "enable" },
            ]
          : undefined;

      const effectiveToolPolicy: ToolPolicy | undefined =
        toolPolicy || agentToolPolicy.length > 0 || systemWorkspaceToolPolicy
          ? [...agentToolPolicy, ...(toolPolicy ?? []), ...(systemWorkspaceToolPolicy ?? [])]
          : undefined;

      // Compute tool names for agent transition sentinel.
      const earlyRuntime = createRuntime({ type: "local", srcBaseDir: process.cwd() });
      const earlyAllTools = await getToolsForModel(
        modelString,
        {
          cwd: process.cwd(),
          runtime: earlyRuntime,
          runtimeTempDir: os.tmpdir(),
          secrets: {},
          planFileOnly: agentIsPlanLike,
        },
        "", // Empty workspace ID for early stub config
        this.initStateManager,
        undefined,
        undefined
      );
      const earlyTools = applyToolPolicy(earlyAllTools, effectiveToolPolicy);
      toolNamesForSentinel = Object.keys(earlyTools);

      // Fetch workspace MCP overrides (for filtering servers and tools)
      // NOTE: Stored in <workspace>/.mux/mcp.local.jsonc (not ~/.mux/config.json).
      let mcpOverrides: WorkspaceMCPOverrides | undefined;
      try {
        mcpOverrides =
          await this.workspaceMcpOverridesService.getOverridesForWorkspace(workspaceId);
      } catch (error) {
        log.warn("[MCP] Failed to load workspace MCP overrides; continuing without overrides", {
          workspaceId,
          error,
        });
        mcpOverrides = undefined;
      }

      // Fetch MCP server config for system prompt (before building message)
      // Pass overrides to filter out disabled servers
      const mcpServers =
        this.mcpServerManager && workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID
          ? await this.mcpServerManager.listServers(metadata.projectPath, mcpOverrides)
          : undefined;

      // Construct plan mode instruction if in plan mode
      // This is done backend-side because we have access to the plan file path
      let effectiveAdditionalInstructions = additionalSystemInstructions;
      const muxHome = runtime.getMuxHome();
      const planFilePath = getPlanFilePath(metadata.name, metadata.projectName, muxHome);

      // Read plan file (handles legacy migration transparently)
      const planResult = await readPlanFile(
        runtime,
        metadata.name,
        metadata.projectName,
        workspaceId
      );

      const chatHasStartHerePlanSummary = hasStartHerePlanSummary(filteredMessages);

      if (effectiveMode === "plan") {
        const planModeInstruction = getPlanModeInstruction(planFilePath, planResult.exists);
        effectiveAdditionalInstructions = additionalSystemInstructions
          ? `${planModeInstruction}\n\n${additionalSystemInstructions}`
          : planModeInstruction;
      } else if (planResult.exists && planResult.content.trim()) {
        // Users often use "Replace all chat history" after plan mode. In exec (or other non-plan)
        // modes, the model can lose the plan file location because plan path injection only
        // happens in plan mode.
        //
        // Exception: the ProposePlanToolCall "Start Here" flow already stores the full plan
        // (and plan path) directly in chat history. In that case, prompting the model to
        // re-open the plan file is redundant and often results in an extra "read …KB" step.
        if (!chatHasStartHerePlanSummary) {
          const planFileHint = getPlanFileHint(planFilePath, planResult.exists);
          if (planFileHint) {
            effectiveAdditionalInstructions = effectiveAdditionalInstructions
              ? `${planFileHint}\n\n${effectiveAdditionalInstructions}`
              : planFileHint;
          }
        } else {
          workspaceLog.debug(
            "Skipping plan file hint: Start Here already includes the plan in chat history."
          );
        }
      }

      if (shouldDisableTaskToolsForDepth) {
        const nestingInstruction =
          `Task delegation is disabled in this workspace (taskDepth=${taskDepth}, ` +
          `maxTaskNestingDepth=${taskSettings.maxTaskNestingDepth}). Do not call task/task_await/task_list/task_terminate.`;
        effectiveAdditionalInstructions = effectiveAdditionalInstructions
          ? `${effectiveAdditionalInstructions}\n\n${nestingInstruction}`
          : nestingInstruction;
      }

      // Read plan content for agent transition (plan-like → exec/orchestrator).
      // Only read if switching to the built-in exec/orchestrator agent and last assistant was plan-like.
      let planContentForTransition: string | undefined;
      const isPlanHandoffAgent = effectiveAgentId === "exec" || effectiveAgentId === "orchestrator";
      if (isPlanHandoffAgent && !chatHasStartHerePlanSummary) {
        const lastAssistantMessage = [...filteredMessages]
          .reverse()
          .find((m) => m.role === "assistant");
        const lastAgentId = lastAssistantMessage?.metadata?.agentId;
        if (lastAgentId && planResult.content.trim()) {
          let lastAgentIsPlanLike = false;
          if (lastAgentId === effectiveAgentId) {
            lastAgentIsPlanLike = agentIsPlanLike;
          } else {
            try {
              const lastDefinition = await readAgentDefinition(
                runtime,
                agentDiscoveryPath,
                lastAgentId
              );
              const lastChain = await resolveAgentInheritanceChain({
                runtime,
                workspacePath: agentDiscoveryPath,
                agentId: lastAgentId,
                agentDefinition: lastDefinition,
                workspaceId,
              });
              lastAgentIsPlanLike = isPlanLikeInResolvedChain(lastChain);
            } catch (error) {
              workspaceLog.warn("Failed to resolve last agent definition for plan handoff", {
                lastAgentId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

          if (lastAgentIsPlanLike) {
            planContentForTransition = planResult.content;
          }
        }
      } else if (isPlanHandoffAgent && chatHasStartHerePlanSummary) {
        workspaceLog.debug(
          "Skipping plan content injection for plan handoff transition: Start Here already includes the plan in chat history."
        );
      }

      // Now inject agent transition context with plan content (runtime is now available)
      const messagesWithAgentContext = injectAgentTransition(
        messagesWithSentinel,
        effectiveAgentId,
        toolNamesForSentinel,
        planContentForTransition,
        planContentForTransition ? planFilePath : undefined
      );

      // Inject file change notifications as user messages (preserves system message cache)
      const messagesWithFileChanges = injectFileChangeNotifications(
        messagesWithAgentContext,
        changedFileAttachments
      );

      // Inject post-compaction attachments (plan file, edited files) after compaction summary
      const messagesWithPostCompaction = injectPostCompactionAttachments(
        messagesWithFileChanges,
        postCompactionAttachments
      );

      // Expand @file mentions (e.g. @src/foo.ts#L1-20) into an in-memory synthetic user message.
      // This keeps chat history clean while giving the model immediate file context.
      const messagesWithFileAtMentions = await injectFileAtMentions(messagesWithPostCompaction, {
        runtime,
        workspacePath,
        abortSignal: combinedAbortSignal,
      });

      // Apply centralized tool-output redaction BEFORE converting to provider ModelMessages
      // This keeps the persisted/UI history intact while trimming heavy fields for the request
      const redactedForProvider = applyToolOutputRedaction(messagesWithFileAtMentions);
      log.debug_obj(`${workspaceId}/2a_redacted_messages.json`, redactedForProvider);

      // Sanitize tool inputs to ensure they are valid objects (not strings or arrays)
      // This fixes cases where corrupted data in history has malformed tool inputs
      // that would cause API errors like "Input should be a valid dictionary"
      const sanitizedMessages = sanitizeToolInputs(redactedForProvider);
      log.debug_obj(`${workspaceId}/2b_sanitized_messages.json`, sanitizedMessages);

      // Inline SVG user attachments as text (providers generally don't accept image/svg+xml as an image input).
      // This is request-only (does not mutate persisted history).
      const messagesWithInlinedSvg = inlineSvgAsTextForProvider(sanitizedMessages);

      // Sanitize PDF filenames for Anthropic (request-only, preserves original in UI/history).
      // Anthropic rejects document names containing periods, underscores, etc.
      const messagesWithSanitizedPdf =
        providerForMessages === "anthropic"
          ? sanitizeAnthropicPdfFilenames(messagesWithInlinedSvg)
          : messagesWithInlinedSvg;

      // Some MCP tools return images as base64 in tool results.
      // Providers can treat tool-result payloads as text/JSON, which can blow up context.
      // Rewrite those tool outputs to small text placeholders and attach the images as file parts.
      const messagesWithToolMediaExtracted =
        extractToolMediaAsUserMessages(messagesWithSanitizedPdf);

      // Convert MuxMessage to ModelMessage format using Vercel AI SDK utility
      // Type assertion needed because MuxMessage has custom tool parts for interrupted tools
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      const rawModelMessages = convertToModelMessages(messagesWithToolMediaExtracted as any, {
        // Drop unfinished tool calls (input-streaming/input-available) so downstream
        // transforms only see tool calls that actually produced outputs.
        ignoreIncompleteToolCalls: true,
      });

      // Self-healing: Filter out any empty ModelMessages that could brick the request.
      // The SDK's ignoreIncompleteToolCalls can drop all parts from a message, leaving
      // an assistant with empty content array. The API rejects these with "all messages
      // must have non-empty content except for the optional final assistant message".
      const modelMessages = rawModelMessages.filter((msg) => {
        if (msg.role !== "assistant") return true;
        if (typeof msg.content === "string") return msg.content.length > 0;
        return Array.isArray(msg.content) && msg.content.length > 0;
      });
      if (modelMessages.length < rawModelMessages.length) {
        log.debug(
          `Self-healing: Filtered ${rawModelMessages.length - modelMessages.length} empty ModelMessage(s)`
        );
      }
      log.debug_obj(`${workspaceId}/2_model_messages.json`, modelMessages);

      // Apply ModelMessage transforms based on provider requirements
      const transformedMessages = transformModelMessages(modelMessages, providerForMessages, {
        anthropicThinkingEnabled:
          providerForMessages === "anthropic" && effectiveThinkingLevel !== "off",
      });

      // Apply cache control for Anthropic models AFTER transformation
      const finalMessages = applyCacheControl(transformedMessages, modelString);

      log.debug_obj(`${workspaceId}/3_final_messages.json`, finalMessages);

      // Validate the messages meet Anthropic requirements (Anthropic only)
      if (providerForMessages === "anthropic") {
        const validation = validateAnthropicCompliance(finalMessages);
        if (!validation.valid) {
          log.error(
            `Anthropic compliance validation failed: ${validation.error ?? "unknown error"}`
          );
          // Continue anyway, as the API might be more lenient
        }
      }

      // Construct effective agent system prompt
      // 1. Resolve the body with inheritance (prompt.append merges with base)
      // 2. If running as subagent, append subagent.append_prompt
      // Note: Use agentDefinition.id (may have fallen back to exec) instead of effectiveAgentId
      const resolvedBody = await resolveAgentBody(runtime, agentDiscoveryPath, agentDefinition.id);

      let subagentAppendPrompt: string | undefined;
      if (isSubagentWorkspace) {
        try {
          const resolvedFrontmatter = await resolveAgentFrontmatter(
            runtime,
            agentDiscoveryPath,
            agentDefinition.id
          );
          subagentAppendPrompt = resolvedFrontmatter.subagent?.append_prompt;
        } catch (error: unknown) {
          workspaceLog.debug("Failed to resolve agent frontmatter for subagent append_prompt", {
            agentId: agentDefinition.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const agentSystemPrompt =
        isSubagentWorkspace && subagentAppendPrompt
          ? `${resolvedBody}\n\n${subagentAppendPrompt}`
          : resolvedBody;

      // Discover available agent definitions for sub-agent context (only for top-level workspaces).
      //
      // NOTE: discoverAgentDefinitions returns disabled agents too, so Settings can surface them.
      // For tool descriptions (task tool), filter to agents that are effectively enabled.
      let agentDefinitions: Awaited<ReturnType<typeof discoverAgentDefinitions>> | undefined;
      if (!isSubagentWorkspace) {
        agentDefinitions = await discoverAvailableSubagentsForToolContext({
          runtime,
          workspacePath: agentDiscoveryPath,
          cfg,
        });
      }

      // Discover available skills for tool description context
      let availableSkills: Awaited<ReturnType<typeof discoverAgentSkills>> | undefined;
      try {
        availableSkills = await discoverAgentSkills(runtime, workspacePath);
      } catch (error) {
        workspaceLog.warn("Failed to discover agent skills for tool description", { error });
      }

      // Build system message from workspace metadata
      const systemMessage = await buildSystemMessage(
        metadata,
        runtime,
        workspacePath,
        effectiveAdditionalInstructions,
        modelString,
        mcpServers,
        { agentSystemPrompt }
      );

      // Count system message tokens for cost tracking
      const tokenizer = await getTokenizerForModel(modelString);
      const systemMessageTokens = await tokenizer.countTokens(systemMessage);

      // Load project secrets (system workspace never gets secrets injected)
      const projectSecrets =
        workspaceId === MUX_HELP_CHAT_WORKSPACE_ID
          ? []
          : this.config.getEffectiveSecrets(metadata.projectPath);

      // Generate stream token and create temp directory for tools
      const streamToken = this.streamManager.generateStreamToken();

      let mcpTools: Record<string, Tool> | undefined;
      let mcpStats: MCPWorkspaceStats | undefined;
      let mcpSetupDurationMs = 0;

      if (this.mcpServerManager && workspaceId !== MUX_HELP_CHAT_WORKSPACE_ID) {
        const start = Date.now();
        try {
          const result = await this.mcpServerManager.getToolsForWorkspace({
            workspaceId,
            projectPath: metadata.projectPath,
            runtime,
            workspacePath,
            overrides: mcpOverrides,
            projectSecrets: secretsToRecord(projectSecrets),
          });

          mcpTools = result.tools;
          mcpStats = result.stats;
        } catch (error) {
          workspaceLog.error("Failed to start MCP servers", { error });
        } finally {
          mcpSetupDurationMs = Date.now() - start;
        }
      }

      const runtimeTempDir = await this.streamManager.createTempDirForStream(streamToken, runtime);

      // Extract tool-specific instructions from AGENTS.md files and agent definition
      const toolInstructions = await readToolInstructions(
        metadata,
        runtime,
        workspacePath,
        modelString,
        agentSystemPrompt
      );

      // Calculate cumulative session costs for MUX_COSTS_USD env var
      let sessionCostsUsd: number | undefined;
      if (this.sessionUsageService) {
        const sessionUsage = await this.sessionUsageService.getSessionUsage(workspaceId);
        if (sessionUsage) {
          const allUsage = sumUsageHistory(Object.values(sessionUsage.byModel));
          sessionCostsUsd = getTotalCost(allUsage);
        }
      }

      // Get model-specific tools with workspace path (correct for local or remote)
      const allTools = await getToolsForModel(
        modelString,
        {
          cwd: workspacePath,
          runtime,
          secrets: secretsToRecord(projectSecrets),
          muxEnv: getMuxEnv(
            metadata.projectPath,
            getRuntimeType(metadata.runtimeConfig),
            metadata.name,
            {
              modelString,
              thinkingLevel: thinkingLevel ?? "off",
              costsUsd: sessionCostsUsd,
            }
          ),
          runtimeTempDir,
          backgroundProcessManager: this.backgroundProcessManager,
          // Plan agent configuration for plan file access.
          // - read: plan file is readable in all agents (useful context)
          // - write: enforced by file_edit_* tools (plan file is read-only outside plan agent)
          planFileOnly: agentIsPlanLike,
          emitChatEvent: (event) => {
            // Defensive: tools should only emit events for the workspace they belong to.
            if ("workspaceId" in event && event.workspaceId !== workspaceId) {
              return;
            }
            this.emit(event.type, event as never);
          },
          workspaceSessionDir: this.config.getSessionDir(workspaceId),
          planFilePath,
          workspaceId,
          // Only child workspaces (tasks) can report to a parent.
          enableAgentReport: Boolean(metadata.parentWorkspaceId),
          // External edit detection callback
          recordFileState,
          taskService: this.taskService,
          // PTC experiments for inheritance to subagents
          experiments,
          // Dynamic context for tool descriptions (moved from system prompt for better model attention)
          availableSubagents: agentDefinitions,
          availableSkills,
        },
        workspaceId,
        this.initStateManager,
        toolInstructions,
        mcpTools
      );

      // Merge in extra tools (e.g., CLI-specific tools like set_exit_code)
      // These bypass policy filtering since they're injected by the runtime, not user config
      const allToolsWithExtra = this.extraTools ? { ...allTools, ...this.extraTools } : allTools;

      // NOTE: effectiveToolPolicy is derived from the selected agent definition (plus hard-denies).

      // Apply tool policy FIRST - this must happen before PTC to ensure sandbox
      // respects allow/deny filters. The policy-filtered tools are passed to
      // ToolBridge so the mux.* API only exposes policy-allowed tools.
      const policyFilteredTools = applyToolPolicy(allToolsWithExtra, effectiveToolPolicy);

      // Handle PTC experiments - add or replace tools with code_execution
      let toolsForModel = policyFilteredTools;
      if (experiments?.programmaticToolCalling || experiments?.programmaticToolCallingExclusive) {
        try {
          // Lazy-load PTC modules only when experiments are enabled
          const ptc = await getPTCModules();

          // Create emit callback that forwards nested events to stream
          // Only forward tool-call-start/end events, not console events
          const emitNestedEvent = (event: PTCEventWithParent): void => {
            if (event.type === "tool-call-start" || event.type === "tool-call-end") {
              this.streamManager.emitNestedToolEvent(workspaceId, assistantMessageId, event);
            }
            // Console events are not streamed (appear in final result only)
          };

          // ToolBridge uses policy-filtered tools - sandbox only exposes allowed tools
          const toolBridge = new ptc.ToolBridge(policyFilteredTools);

          // Singleton runtime factory (WASM module is expensive to load)
          ptc.runtimeFactory ??= new ptc.QuickJSRuntimeFactory();

          const codeExecutionTool = await ptc.createCodeExecutionTool(
            ptc.runtimeFactory,
            toolBridge,
            emitNestedEvent
          );

          if (experiments?.programmaticToolCallingExclusive) {
            // Exclusive mode: code_execution is mandatory — it's the only way to use bridged
            // tools. The experiment flag is the opt-in; policy cannot disable it here since
            // that would leave no way to access tools. nonBridgeable is already policy-filtered.
            const nonBridgeable = toolBridge.getNonBridgeableTools();
            toolsForModel = { ...nonBridgeable, code_execution: codeExecutionTool };
          } else {
            // Supplement mode: add code_execution, then apply policy to determine final set.
            // This correctly handles all policy combinations (require, enable, disable).
            toolsForModel = applyToolPolicy(
              { ...policyFilteredTools, code_execution: codeExecutionTool },
              effectiveToolPolicy
            );
          }
        } catch (error) {
          // Fall back to policy-filtered tools if PTC creation fails
          log.error("Failed to create code_execution tool, falling back to base tools", { error });
        }
      }

      const tools = toolsForModel;

      const effectiveMcpStats: MCPWorkspaceStats =
        mcpStats ??
        ({
          enabledServerCount: 0,
          startedServerCount: 0,
          failedServerCount: 0,
          autoFallbackCount: 0,
          hasStdio: false,
          hasHttp: false,
          hasSse: false,
          transportMode: "none",
        } satisfies MCPWorkspaceStats);

      const mcpToolNames = new Set(Object.keys(mcpTools ?? {}));
      const toolNames = Object.keys(tools);
      const mcpToolCount = toolNames.filter((name) => mcpToolNames.has(name)).length;
      const totalToolCount = toolNames.length;
      const builtinToolCount = Math.max(0, totalToolCount - mcpToolCount);

      this.telemetryService?.capture({
        event: "mcp_context_injected",
        properties: {
          workspaceId,
          model: modelString,
          agentId: effectiveAgentId,
          runtimeType: getRuntimeTypeForTelemetry(metadata.runtimeConfig),

          mcp_server_enabled_count: effectiveMcpStats.enabledServerCount,
          mcp_server_started_count: effectiveMcpStats.startedServerCount,
          mcp_server_failed_count: effectiveMcpStats.failedServerCount,

          mcp_tool_count: mcpToolCount,
          total_tool_count: totalToolCount,
          builtin_tool_count: builtinToolCount,

          mcp_transport_mode: effectiveMcpStats.transportMode,
          mcp_has_http: effectiveMcpStats.hasHttp,
          mcp_has_sse: effectiveMcpStats.hasSse,
          mcp_has_stdio: effectiveMcpStats.hasStdio,
          mcp_auto_fallback_count: effectiveMcpStats.autoFallbackCount,
          mcp_setup_duration_ms_b2: roundToBase2(mcpSetupDurationMs),
        },
      });

      log.info("AIService.streamMessage: tool configuration", {
        workspaceId,
        model: modelString,
        toolNames: Object.keys(tools),
        hasToolPolicy: Boolean(effectiveToolPolicy),
      });

      // Create assistant message placeholder with historySequence from backend

      if (combinedAbortSignal.aborted) {
        return Ok(undefined);
      }
      const assistantMessageId = createAssistantMessageId();
      const assistantMessage = createMuxMessage(assistantMessageId, "assistant", "", {
        timestamp: Date.now(),
        model: canonicalModelString,
        routedThroughGateway,
        systemMessageTokens,
        agentId: effectiveAgentId,
      });

      // Append to history to get historySequence assigned
      const appendResult = await this.historyService.appendToHistory(workspaceId, assistantMessage);
      if (!appendResult.success) {
        return Err({ type: "unknown", raw: appendResult.error });
      }

      // Get the assigned historySequence
      const historySequence = assistantMessage.metadata?.historySequence ?? 0;

      const forceContextLimitError =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.forceContextLimitError === true;
      const simulateToolPolicyNoop =
        modelString.startsWith("openai:") &&
        effectiveMuxProviderOptions.openai?.simulateToolPolicyNoop === true;

      if (forceContextLimitError) {
        const errorMessage =
          "Context length exceeded: the conversation is too long to send to this OpenAI model. Please shorten the history and try again.";

        const errorPartialMessage: MuxMessage = {
          id: assistantMessageId,
          role: "assistant",
          metadata: {
            historySequence,
            timestamp: Date.now(),
            model: canonicalModelString,
            routedThroughGateway,
            systemMessageTokens,
            agentId: effectiveAgentId,
            partial: true,
            error: errorMessage,
            errorType: "context_exceeded",
          },
          parts: [],
        };

        await this.partialService.writePartial(workspaceId, errorPartialMessage);

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: canonicalModelString,
          routedThroughGateway,
          historySequence,
          startTime: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
        };
        this.emit("stream-start", streamStartEvent);

        this.emit(
          "error",
          createErrorEvent(workspaceId, {
            messageId: assistantMessageId,
            error: errorMessage,
            errorType: "context_exceeded",
          })
        );

        return Ok(undefined);
      }

      if (simulateToolPolicyNoop) {
        const noopMessage = createMuxMessage(assistantMessageId, "assistant", "", {
          timestamp: Date.now(),
          model: canonicalModelString,
          routedThroughGateway,
          systemMessageTokens,
          agentId: effectiveAgentId,
          toolPolicy: effectiveToolPolicy,
        });

        const parts: StreamEndEvent["parts"] = [
          {
            type: "text",
            text: "Tool execution skipped because the requested tool is disabled by policy.",
          },
        ];

        const streamStartEvent: StreamStartEvent = {
          type: "stream-start",
          workspaceId,
          messageId: assistantMessageId,
          model: canonicalModelString,
          routedThroughGateway,
          historySequence,
          startTime: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
        };
        this.emit("stream-start", streamStartEvent);

        const textParts = parts.filter((part): part is MuxTextPart => part.type === "text");
        if (textParts.length === 0) {
          throw new Error("simulateToolPolicyNoop requires at least one text part");
        }

        for (const textPart of textParts) {
          if (textPart.text.length === 0) {
            continue;
          }

          const streamDeltaEvent: StreamDeltaEvent = {
            type: "stream-delta",
            workspaceId,
            messageId: assistantMessageId,
            delta: textPart.text,
            tokens: 0, // Mock scenario - actual tokenization happens in streamManager
            timestamp: Date.now(),
          };
          this.emit("stream-delta", streamDeltaEvent);
        }

        const streamEndEvent: StreamEndEvent = {
          type: "stream-end",
          workspaceId,
          messageId: assistantMessageId,
          metadata: {
            model: canonicalModelString,
            routedThroughGateway,
            systemMessageTokens,
          },
          parts,
        };
        this.emit("stream-end", streamEndEvent);

        const finalAssistantMessage: MuxMessage = {
          ...noopMessage,
          metadata: {
            ...noopMessage.metadata,
            historySequence,
          },
          parts,
        };

        await this.partialService.deletePartial(workspaceId);
        await this.historyService.updateHistory(workspaceId, finalAssistantMessage);
        return Ok(undefined);
      }

      // Build provider options based on thinking level and message history
      const truncationMode = openaiTruncationModeOverride;
      // Pass filtered messages so OpenAI can extract previousResponseId for persistence
      // Also pass callback to filter out lost responseIds (OpenAI invalidated them)
      // Pass workspaceId to derive stable promptCacheKey for OpenAI caching
      const providerOptions = buildProviderOptions(
        modelString,
        effectiveThinkingLevel,
        filteredMessages,
        (id) => this.streamManager.isResponseIdLost(id),
        effectiveMuxProviderOptions,
        workspaceId,
        truncationMode
      );

      // Debug dump: Log the complete LLM request when MUX_DEBUG_LLM_REQUEST is set
      // This helps diagnose issues with system prompts, messages, tools, etc.
      if (process.env.MUX_DEBUG_LLM_REQUEST === "1") {
        const llmRequest = {
          workspaceId,
          model: modelString,
          systemMessage,
          messages: finalMessages,
          tools: Object.fromEntries(
            Object.entries(tools).map(([name, tool]) => [
              name,
              {
                description: tool.description,
                inputSchema: tool.inputSchema,
              },
            ])
          ),
          providerOptions,
          thinkingLevel: effectiveThinkingLevel,
          maxOutputTokens,
          mode: effectiveMode,
          agentId: effectiveAgentId,
          toolPolicy: effectiveToolPolicy,
        };
        log.info(
          `[MUX_DEBUG_LLM_REQUEST] Full LLM request:\n${JSON.stringify(llmRequest, null, 2)}`
        );
      }

      if (combinedAbortSignal.aborted) {
        const deleteResult = await this.historyService.deleteMessage(
          workspaceId,
          assistantMessageId
        );
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${assistantMessageId}): ${deleteResult.error}`
          );
        }
        return Ok(undefined);
      }

      // Capture request payload for the debug modal, then delegate to StreamManager.
      const snapshot: DebugLlmRequestSnapshot = {
        capturedAt: Date.now(),
        workspaceId,
        messageId: assistantMessageId,
        model: modelString,
        providerName: canonicalProviderName,
        thinkingLevel: effectiveThinkingLevel,
        mode: effectiveMode,
        agentId: effectiveAgentId,
        maxOutputTokens,
        systemMessage,
        messages: finalMessages,
      };

      try {
        const cloned =
          typeof structuredClone === "function"
            ? structuredClone(snapshot)
            : (JSON.parse(JSON.stringify(snapshot)) as DebugLlmRequestSnapshot);

        this.lastLlmRequestByWorkspace.set(workspaceId, cloned);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        workspaceLog.warn("Failed to capture debug LLM request snapshot", { error: errMsg });
      }
      const toolsForStream =
        experiments?.system1 === true
          ? (() => {
              const baseBashTool = tools.bash;
              const baseBashOutputTool = tools.bash_output;
              const baseTaskAwaitTool = tools.task_await;
              if (!baseBashTool) {
                return tools;
              }

              const baseBashToolRecord = baseBashTool as unknown as Record<string, unknown>;
              const originalExecute = baseBashToolRecord.execute;
              if (typeof originalExecute !== "function") {
                return tools;
              }

              const executeFn = originalExecute as (
                this: unknown,
                args: unknown,
                options: unknown
              ) => Promise<unknown>;

              const getExecuteFnForTool = (
                targetTool: Tool | undefined
              ):
                | ((this: unknown, args: unknown, options: unknown) => Promise<unknown>)
                | undefined => {
                if (!targetTool) {
                  return undefined;
                }

                const toolRecord = targetTool as unknown as Record<string, unknown>;
                const execute = toolRecord.execute;
                if (typeof execute !== "function") {
                  return undefined;
                }

                return execute as (
                  this: unknown,
                  args: unknown,
                  options: unknown
                ) => Promise<unknown>;
              };

              const bashOutputExecuteFn = getExecuteFnForTool(baseBashOutputTool);
              const taskAwaitExecuteFn = getExecuteFnForTool(baseTaskAwaitTool);

              const rawSystem1Model = typeof system1Model === "string" ? system1Model.trim() : "";
              const system1ModelString = rawSystem1Model
                ? normalizeGatewayModel(rawSystem1Model)
                : "";
              const system1ExplicitGateway = rawSystem1Model.startsWith("mux-gateway:");
              const effectiveSystem1ModelStringForThinking = system1ModelString || modelString;
              const effectiveSystem1ThinkingLevel = enforceThinkingPolicy(
                effectiveSystem1ModelStringForThinking,
                system1ThinkingLevel ?? "off"
              );

              let cachedSystem1Model: { modelString: string; model: LanguageModel } | undefined;
              let cachedSystem1ModelFailed = false;

              const getSystem1ModelForStream = async (): Promise<
                { modelString: string; model: LanguageModel } | undefined
              > => {
                if (!system1ModelString) {
                  return { modelString: effectiveModelString, model: modelResult.data };
                }

                if (cachedSystem1Model) {
                  return cachedSystem1Model;
                }
                if (cachedSystem1ModelFailed) {
                  return undefined;
                }

                const resolvedSystem1ModelString = this.resolveGatewayModelString(
                  system1ModelString,
                  undefined,
                  system1ExplicitGateway
                );
                const created = await this.createModel(
                  resolvedSystem1ModelString,
                  effectiveMuxProviderOptions
                );
                if (!created.success) {
                  cachedSystem1ModelFailed = true;
                  log.debug("[system1] Failed to create System 1 model", {
                    workspaceId,
                    system1Model: system1ModelString,
                    error: created.error,
                  });
                  return undefined;
                }

                cachedSystem1Model = {
                  modelString: resolvedSystem1ModelString,
                  model: created.data,
                };
                return cachedSystem1Model;
              };

              const maybeFilterBashOutputWithSystem1 = async (params: {
                toolName: string;
                output: string;
                script: string;
                displayName?: string;
                toolCallId?: string;
                abortSignal?: AbortSignal;
              }): Promise<{ filteredOutput: string; notice: string } | undefined> => {
                let system1TimedOut = false;

                if (typeof params.output !== "string" || params.output.length === 0) {
                  return undefined;
                }

                // Apply hard truncation as a safety net. This ensures output is bounded
                // even when System1 compaction is skipped or fails.
                const hardTruncation = truncateBashOutput(params.output);

                // Helper to return truncation result when skipping System1 compaction
                const returnHardTruncationIfNeeded = ():
                  | { filteredOutput: string; notice: string }
                  | undefined => {
                  if (!hardTruncation.truncated) {
                    return undefined;
                  }
                  return {
                    filteredOutput: hardTruncation.output,
                    notice: `Output exceeded hard limits (${hardTruncation.originalLines} lines, ${hardTruncation.originalBytes} bytes). Showing last ${hardTruncation.output.split("\n").length} lines.`,
                  };
                };

                try {
                  const minLines =
                    taskSettings.bashOutputCompactionMinLines ??
                    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinLines.default;
                  const minTotalBytes =
                    taskSettings.bashOutputCompactionMinTotalBytes ??
                    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMinTotalBytes.default;
                  const userMaxKeptLines =
                    taskSettings.bashOutputCompactionMaxKeptLines ??
                    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionMaxKeptLines.default;
                  const heuristicFallbackEnabled =
                    taskSettings.bashOutputCompactionHeuristicFallback ??
                    DEFAULT_TASK_SETTINGS.bashOutputCompactionHeuristicFallback ??
                    true;

                  const timeoutMs =
                    taskSettings.bashOutputCompactionTimeoutMs ??
                    SYSTEM1_BASH_OUTPUT_COMPACTION_LIMITS.bashOutputCompactionTimeoutMs.default;

                  const lines = splitBashOutputLines(params.output);
                  const bytes = Buffer.byteLength(params.output, "utf-8");

                  const decision = decideBashOutputCompaction({
                    toolName: params.toolName,
                    script: params.script,
                    displayName: params.displayName,
                    planFilePath: effectiveMode === "plan" ? planFilePath : undefined,
                    totalLines: lines.length,
                    totalBytes: bytes,
                    minLines,
                    minTotalBytes,
                    maxKeptLines: userMaxKeptLines,
                  });

                  const triggeredByLines = decision.triggeredByLines;
                  const triggeredByBytes = decision.triggeredByBytes;

                  if (!triggeredByLines && !triggeredByBytes) {
                    // Output is below compaction thresholds, but may still exceed hard limits
                    return returnHardTruncationIfNeeded();
                  }

                  if (!decision.shouldCompact) {
                    log.debug("[system1] Skipping bash output compaction", {
                      workspaceId,
                      toolName: params.toolName,
                      skipReason: decision.skipReason,
                      intent: decision.intent,
                      alreadyTargeted: decision.alreadyTargeted,
                      displayName: params.displayName,
                      totalLines: lines.length,
                      totalBytes: bytes,
                      triggeredByLines,
                      triggeredByBytes,
                      minLines,
                      minTotalBytes,
                      userMaxKeptLines,
                      heuristicFallbackEnabled,
                      timeoutMs,
                    });

                    // System1 compaction skipped, but still apply hard limits
                    return returnHardTruncationIfNeeded();
                  }

                  const maxKeptLines = decision.effectiveMaxKeptLines;

                  log.debug("[system1] Bash output compaction triggered", {
                    workspaceId,
                    toolName: params.toolName,
                    intent: decision.intent,
                    alreadyTargeted: decision.alreadyTargeted,
                    displayName: params.displayName,
                    totalLines: lines.length,
                    totalBytes: bytes,
                    triggeredByLines,
                    triggeredByBytes,
                    minLines,
                    minTotalBytes,
                    userMaxKeptLines,
                    maxKeptLines,
                    heuristicFallbackEnabled,
                    timeoutMs,
                  });

                  let fullOutputPath: string | undefined;
                  try {
                    // Use 8 hex characters for short, memorable temp file IDs.
                    const fileId = Math.random().toString(16).substring(2, 10);
                    fullOutputPath = path.posix.join(runtimeTempDir, `bash-full-${fileId}.txt`);

                    const writer = runtime.writeFile(fullOutputPath, params.abortSignal);
                    const encoder = new TextEncoder();
                    const writerInstance = writer.getWriter();
                    await writerInstance.write(encoder.encode(params.output));
                    await writerInstance.close();
                  } catch (error) {
                    log.debug("[system1] Failed to save full bash output to temp file", {
                      workspaceId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                    fullOutputPath = undefined;
                  }

                  const system1 = await getSystem1ModelForStream();
                  if (!system1) {
                    return undefined;
                  }

                  const system1ProviderOptions = buildProviderOptions(
                    system1.modelString,
                    effectiveSystem1ThinkingLevel,
                    undefined,
                    undefined,
                    effectiveMuxProviderOptions,
                    workspaceId
                  ) as unknown as Record<string, unknown>;

                  const numberedOutput = formatNumberedLinesForSystem1(lines);

                  const startTimeMs = Date.now();

                  if (typeof params.toolCallId === "string" && params.toolCallId.length > 0) {
                    this.emit("bash-output", {
                      type: "bash-output",
                      workspaceId,
                      toolCallId: params.toolCallId,
                      phase: "filtering",
                      text: "",
                      isError: false,
                      timestamp: Date.now(),
                    } satisfies BashOutputEvent);
                  }

                  let filterMethod: "system1" | "heuristic" = "system1";
                  let keepRangesCount = 0;
                  let finishReason: string | undefined;
                  let lastErrorName: string | undefined;
                  let lastErrorMessage: string | undefined;

                  let applied: ReturnType<typeof applySystem1KeepRangesToOutput> = undefined;

                  try {
                    const keepRangesResult = await runSystem1KeepRangesForBashOutput({
                      runtime,
                      agentDiscoveryPath,
                      runtimeTempDir,
                      model: system1.model,
                      modelString: system1.modelString,
                      providerOptions: system1ProviderOptions,
                      displayName: params.displayName,
                      script: params.script,
                      numberedOutput,
                      maxKeptLines,
                      timeoutMs,
                      abortSignal: params.abortSignal,
                      onTimeout: () => {
                        system1TimedOut = true;
                      },
                    });

                    if (keepRangesResult) {
                      finishReason = keepRangesResult.finishReason;
                      keepRangesCount = keepRangesResult.keepRanges.length;
                      applied = applySystem1KeepRangesToOutput({
                        rawOutput: params.output,
                        keepRanges: keepRangesResult.keepRanges,
                        maxKeptLines,
                      });
                    }
                  } catch (error) {
                    lastErrorName = error instanceof Error ? error.name : undefined;
                    lastErrorMessage = error instanceof Error ? error.message : String(error);
                  }

                  if (!applied || applied.keptLines === 0) {
                    const elapsedMs = Date.now() - startTimeMs;
                    const upstreamAborted = params.abortSignal?.aborted ?? false;

                    log.debug("[system1] Failed to generate keep_ranges", {
                      workspaceId,
                      toolName: params.toolName,
                      system1Model: system1.modelString,
                      elapsedMs,
                      timedOut: system1TimedOut,
                      upstreamAborted,
                      keepRangesCount,
                      errorName: lastErrorName,
                      error: lastErrorMessage,
                    });

                    if (!heuristicFallbackEnabled || upstreamAborted) {
                      return undefined;
                    }

                    const heuristicKeepRanges = getHeuristicKeepRangesForBashOutput({
                      lines,
                      maxKeptLines,
                    });
                    keepRangesCount = heuristicKeepRanges.length;
                    applied = applySystem1KeepRangesToOutput({
                      rawOutput: params.output,
                      keepRanges: heuristicKeepRanges,
                      maxKeptLines,
                    });
                    filterMethod = "heuristic";
                  }

                  if (!applied || applied.keptLines === 0) {
                    log.debug("[system1] keep_ranges produced empty filtered output", {
                      workspaceId,
                      toolName: params.toolName,
                      filterMethod,
                      keepRangesCount,
                      maxKeptLines,
                      totalLines: lines.length,
                    });
                    return undefined;
                  }

                  const elapsedMs = Date.now() - startTimeMs;

                  const trigger = [
                    triggeredByLines ? "lines" : null,
                    triggeredByBytes ? "bytes" : null,
                  ]
                    .filter(Boolean)
                    .join("+");

                  const notice = formatSystem1BashFilterNotice({
                    keptLines: applied.keptLines,
                    totalLines: applied.totalLines,
                    trigger,
                    fullOutputPath,
                  });

                  log.debug("[system1] Filtered bash tool output", {
                    workspaceId,
                    toolName: params.toolName,
                    intent: decision.intent,
                    alreadyTargeted: decision.alreadyTargeted,
                    displayName: params.displayName,
                    userMaxKeptLines,
                    maxKeptLines,
                    system1Model: system1.modelString,
                    filterMethod,
                    keepRangesCount,
                    finishReason,
                    elapsedMs,
                    keptLines: applied.keptLines,
                    totalLines: applied.totalLines,
                    totalBytes: bytes,
                    triggeredByLines,
                    triggeredByBytes,
                    timeoutMs,
                  });

                  return { filteredOutput: applied.filteredOutput, notice };
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  const errorName = error instanceof Error ? error.name : undefined;
                  const upstreamAborted = params.abortSignal?.aborted ?? false;
                  const isAbortError = errorName === "AbortError";

                  log.debug("[system1] Failed to filter bash tool output", {
                    workspaceId,
                    toolName: params.toolName,
                    error: errorMessage,
                    errorName,
                    timedOut: system1TimedOut,
                    upstreamAborted,
                    isAbortError,
                  });
                  // System1 failed, but still apply hard limits as safety net
                  return returnHardTruncationIfNeeded();
                }
              };

              const wrappedBashTool = cloneToolPreservingDescriptors(baseBashTool);
              const wrappedBashToolRecord = wrappedBashTool as unknown as Record<string, unknown>;

              wrappedBashToolRecord.execute = async (args: unknown, options: unknown) => {
                const result: unknown = await executeFn.call(baseBashTool, args, options);

                try {
                  const runInBackground =
                    Boolean(
                      (args as { run_in_background?: unknown } | undefined)?.run_in_background
                    ) ||
                    (result && typeof result === "object" && "backgroundProcessId" in result);
                  if (runInBackground) {
                    return result;
                  }

                  const output = (result as { output?: unknown } | undefined)?.output;
                  if (typeof output !== "string" || output.length === 0) {
                    return result;
                  }

                  const displayName =
                    typeof (args as { display_name?: unknown } | undefined)?.display_name ===
                    "string"
                      ? String((args as { display_name?: unknown }).display_name).trim() ||
                        undefined
                      : undefined;
                  const script =
                    typeof (args as { script?: unknown } | undefined)?.script === "string"
                      ? String((args as { script?: unknown }).script)
                      : "";

                  const toolCallId =
                    typeof (options as { toolCallId?: unknown } | undefined)?.toolCallId ===
                    "string"
                      ? (options as { toolCallId?: string }).toolCallId
                      : undefined;

                  const filtered = await maybeFilterBashOutputWithSystem1({
                    toolName: "bash",
                    output,
                    script,
                    displayName,
                    toolCallId,
                    abortSignal: (options as { abortSignal?: AbortSignal } | undefined)
                      ?.abortSignal,
                  });
                  if (!filtered) {
                    return result;
                  }

                  const existingNote = (result as { note?: unknown } | undefined)?.note;
                  return {
                    ...(result as Record<string, unknown>),
                    output: filtered.filteredOutput,
                    note: appendToolNote(
                      typeof existingNote === "string" ? existingNote : undefined,
                      filtered.notice
                    ),
                  };
                } catch (error) {
                  log.debug("[system1] Failed to filter bash tool output", {
                    workspaceId,
                    error: error instanceof Error ? error.message : String(error),
                  });
                  return result;
                }
              };

              const wrappedTools: Record<string, Tool> = { ...tools, bash: wrappedBashTool };

              if (baseBashOutputTool && bashOutputExecuteFn) {
                const wrappedBashOutputTool = cloneToolPreservingDescriptors(baseBashOutputTool);
                const wrappedBashOutputToolRecord = wrappedBashOutputTool as unknown as Record<
                  string,
                  unknown
                >;

                wrappedBashOutputToolRecord.execute = async (args: unknown, options: unknown) => {
                  const result: unknown = await bashOutputExecuteFn.call(
                    baseBashOutputTool,
                    args,
                    options
                  );

                  try {
                    const output = (result as { output?: unknown } | undefined)?.output;
                    if (typeof output !== "string" || output.length === 0) {
                      return result;
                    }

                    const filtered = await maybeFilterBashOutputWithSystem1({
                      toolName: "bash_output",
                      output,
                      script: "",
                      abortSignal: (options as { abortSignal?: AbortSignal } | undefined)
                        ?.abortSignal,
                    });
                    if (!filtered) {
                      return result;
                    }

                    const existingNote = (result as { note?: unknown } | undefined)?.note;
                    return {
                      ...(result as Record<string, unknown>),
                      output: filtered.filteredOutput,
                      note: appendToolNote(
                        typeof existingNote === "string" ? existingNote : undefined,
                        filtered.notice
                      ),
                    };
                  } catch (error) {
                    log.debug("[system1] Failed to filter bash_output tool output", {
                      workspaceId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                    return result;
                  }
                };

                wrappedTools.bash_output = wrappedBashOutputTool;
              }

              if (baseTaskAwaitTool && taskAwaitExecuteFn) {
                const wrappedTaskAwaitTool = cloneToolPreservingDescriptors(baseTaskAwaitTool);
                const wrappedTaskAwaitToolRecord = wrappedTaskAwaitTool as unknown as Record<
                  string,
                  unknown
                >;

                wrappedTaskAwaitToolRecord.execute = async (args: unknown, options: unknown) => {
                  const result: unknown = await taskAwaitExecuteFn.call(
                    baseTaskAwaitTool,
                    args,
                    options
                  );

                  try {
                    const resultsValue = (result as { results?: unknown } | undefined)?.results;
                    if (!Array.isArray(resultsValue) || resultsValue.length === 0) {
                      return result;
                    }

                    const filteredResults = await Promise.all(
                      resultsValue.map(async (entry: unknown) => {
                        if (!entry || typeof entry !== "object") {
                          return entry;
                        }

                        const taskId = (entry as { taskId?: unknown }).taskId;
                        if (typeof taskId !== "string" || !taskId.startsWith("bash:")) {
                          return entry;
                        }

                        const status = (entry as { status?: unknown }).status;

                        if (status === "running") {
                          const output = (entry as { output?: unknown }).output;
                          if (typeof output !== "string" || output.length === 0) {
                            return entry;
                          }

                          const filtered = await maybeFilterBashOutputWithSystem1({
                            toolName: "task_await",
                            output,
                            script: "",
                            abortSignal: (options as { abortSignal?: AbortSignal } | undefined)
                              ?.abortSignal,
                          });
                          if (!filtered) {
                            return entry;
                          }

                          const existingNote = (entry as { note?: unknown }).note;
                          return {
                            ...(entry as Record<string, unknown>),
                            output: filtered.filteredOutput,
                            note: appendToolNote(
                              typeof existingNote === "string" ? existingNote : undefined,
                              filtered.notice
                            ),
                          };
                        }

                        if (status === "completed") {
                          const reportMarkdown = (entry as { reportMarkdown?: unknown })
                            .reportMarkdown;
                          if (typeof reportMarkdown !== "string" || reportMarkdown.length === 0) {
                            return entry;
                          }

                          const parsed = tryParseBashOutputReport(reportMarkdown);
                          if (!parsed || parsed.output.length === 0) {
                            return entry;
                          }

                          const filtered = await maybeFilterBashOutputWithSystem1({
                            toolName: "task_await",
                            output: parsed.output,
                            script: "",
                            abortSignal: (options as { abortSignal?: AbortSignal } | undefined)
                              ?.abortSignal,
                          });
                          if (!filtered) {
                            return entry;
                          }

                          const nextReportMarkdown = formatBashOutputReport({
                            processId: parsed.processId,
                            status: parsed.status,
                            exitCode: parsed.exitCode,
                            output: filtered.filteredOutput,
                          });

                          const existingNote = (entry as { note?: unknown }).note;
                          return {
                            ...(entry as Record<string, unknown>),
                            reportMarkdown: nextReportMarkdown,
                            note: appendToolNote(
                              typeof existingNote === "string" ? existingNote : undefined,
                              filtered.notice
                            ),
                          };
                        }

                        return entry;
                      })
                    );

                    return {
                      ...(result as Record<string, unknown>),
                      results: filteredResults,
                    };
                  } catch (error) {
                    log.debug("[system1] Failed to filter task_await tool output", {
                      workspaceId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                    return result;
                  }
                };

                wrappedTools.task_await = wrappedTaskAwaitTool;
              }

              return wrappedTools;
            })()
          : tools;

      const streamResult = await this.streamManager.startStream(
        workspaceId,
        finalMessages,
        modelResult.data,
        modelString,
        historySequence,
        systemMessage,
        runtime,
        assistantMessageId, // Shared messageId ensures nested tool events match stream events
        combinedAbortSignal,
        toolsForStream,
        {
          systemMessageTokens,
          timestamp: Date.now(),
          agentId: effectiveAgentId,
          mode: effectiveMode,
          routedThroughGateway,
        },
        providerOptions,
        maxOutputTokens,
        effectiveToolPolicy,
        streamToken, // Pass the pre-generated stream token
        hasQueuedMessage,
        metadata.name
      );

      if (!streamResult.success) {
        // StreamManager already returns SendMessageError
        return Err(streamResult.error);
      }

      // If we were interrupted during StreamManager startup before the stream was registered,
      // make sure we don't leave an empty assistant placeholder behind.
      if (combinedAbortSignal.aborted && !this.streamManager.isStreaming(workspaceId)) {
        const deleteResult = await this.historyService.deleteMessage(
          workspaceId,
          assistantMessageId
        );
        if (!deleteResult.success) {
          log.error(
            `Failed to delete aborted assistant placeholder (${assistantMessageId}): ${deleteResult.error}`
          );
        }
      }

      // StreamManager now handles history updates directly on stream-end
      // No need for event listener here
      return Ok(undefined);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error("Stream message error:", error);
      // Return as unknown error type
      return Err({ type: "unknown", raw: `Failed to stream message: ${errorMessage}` });
    } finally {
      unlinkAbortSignal();
      const pending = this.pendingStreamStarts.get(workspaceId);
      if (pending?.abortController === pendingAbortController) {
        this.pendingStreamStarts.delete(workspaceId);
      }
    }
  }

  async stopStream(
    workspaceId: string,
    options?: { soft?: boolean; abandonPartial?: boolean; abortReason?: StreamAbortReason }
  ): Promise<Result<void>> {
    const pending = this.pendingStreamStarts.get(workspaceId);
    const isActuallyStreaming =
      this.mockModeEnabled && this.mockAiStreamPlayer
        ? this.mockAiStreamPlayer.isStreaming(workspaceId)
        : this.streamManager.isStreaming(workspaceId);

    if (pending) {
      pending.abortController.abort();

      // If we're still in pre-stream startup (no StreamManager stream yet), emit a synthetic
      // stream-abort so the renderer can exit the "starting..." UI immediately.
      const abortReason = options?.abortReason ?? "startup";
      if (!isActuallyStreaming) {
        this.emit("stream-abort", {
          type: "stream-abort",
          workspaceId,
          abortReason,
          messageId: pending.syntheticMessageId,
          metadata: { duration: Date.now() - pending.startTime },
          abandonPartial: options?.abandonPartial,
        } satisfies StreamAbortEvent);
      }
    }

    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      this.mockAiStreamPlayer.stop(workspaceId);
      return Ok(undefined);
    }
    return this.streamManager.stopStream(workspaceId, options);
  }

  /**
   * Check if a workspace is currently streaming
   */
  isStreaming(workspaceId: string): boolean {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId);
    }
    return this.streamManager.isStreaming(workspaceId);
  }

  /**
   * Get the current stream state for a workspace
   */
  getStreamState(workspaceId: string): string {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return this.mockAiStreamPlayer.isStreaming(workspaceId) ? "streaming" : "idle";
    }
    return this.streamManager.getStreamState(workspaceId);
  }

  /**
   * Get the current stream info for a workspace if actively streaming
   * Used to re-establish streaming context on frontend reconnection
   */
  getStreamInfo(workspaceId: string): ReturnType<typeof this.streamManager.getStreamInfo> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      return undefined;
    }
    return this.streamManager.getStreamInfo(workspaceId);
  }

  /**
   * Replay stream events
   * Emits the same events that would be emitted during live streaming
   */
  async replayStream(workspaceId: string): Promise<void> {
    if (this.mockModeEnabled && this.mockAiStreamPlayer) {
      await this.mockAiStreamPlayer.replayStream(workspaceId);
      return;
    }
    await this.streamManager.replayStream(workspaceId);
  }

  debugGetLastMockPrompt(workspaceId: string): Result<MuxMessage[] | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockPrompt: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastPrompt(workspaceId));
  }
  debugGetLastMockModel(workspaceId: string): Result<string | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastMockModel: workspaceId is required");
    }

    if (!this.mockModeEnabled || !this.mockAiStreamPlayer) {
      return Ok(null);
    }

    return Ok(this.mockAiStreamPlayer.debugGetLastModel(workspaceId));
  }

  debugGetLastLlmRequest(workspaceId: string): Result<DebugLlmRequestSnapshot | null> {
    if (typeof workspaceId !== "string" || workspaceId.trim().length === 0) {
      return Err("debugGetLastLlmRequest: workspaceId is required");
    }

    return Ok(this.lastLlmRequestByWorkspace.get(workspaceId) ?? null);
  }

  /**
   * DEBUG ONLY: Trigger an artificial stream error for testing.
   * This is used by integration tests to simulate network errors mid-stream.
   * @returns true if an active stream was found and error was triggered
   */
  debugTriggerStreamError(
    workspaceId: string,
    errorMessage = "Test-triggered stream error"
  ): Promise<boolean> {
    return this.streamManager.debugTriggerStreamError(workspaceId, errorMessage);
  }

  /**
   * Wait for workspace initialization to complete (if running).
   * Public wrapper for agent discovery and other callers.
   */
  async waitForInit(workspaceId: string, abortSignal?: AbortSignal): Promise<void> {
    return this.initStateManager.waitForInit(workspaceId, abortSignal);
  }

  async deleteWorkspace(workspaceId: string): Promise<Result<void>> {
    try {
      const workspaceDir = this.config.getSessionDir(workspaceId);
      await fs.rm(workspaceDir, { recursive: true, force: true });
      return Ok(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Err(`Failed to delete workspace: ${message}`);
    }
  }
}
