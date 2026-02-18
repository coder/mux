import * as path from "path";
import type * as schema from "@agentclientprotocol/sdk";
import type { RouterClient } from "@orpc/server";
import { RuntimeConfigSchema } from "@/common/orpc/schemas";
import type { FrontendWorkspaceMetadataSchemaType } from "@/common/orpc/types";
import type { RuntimeConfig } from "@/common/types/runtime";
import { parseThinkingDisplayLabel } from "@/common/types/thinking";
import { defaultModel, resolveModelAlias } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
import { shellQuote } from "@/common/utils/shell";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import { detectDefaultTrunkBranch } from "@/node/git";
import type { AppRouter } from "@/node/orpc/router";
import { resolveModeId, resolveThinkingLevel } from "./configOptions";
import type { SessionState } from "../sessionState";

export interface MuxSessionMeta {
  runtimeConfig?: RuntimeConfig;
  trunkBranch?: string;
  branchName?: string;
  title?: string;
  sectionId?: string;
  modeId?: string;
  modelId?: string;
  thinkingLevel?: string;
}

const LIST_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid _meta.mux.${key}: expected string`);
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMuxMetaRecord(
  meta: Record<string, unknown> | null | undefined
): Record<string, unknown> | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }

  const nested = meta.mux;
  if (isRecord(nested)) {
    return nested;
  }

  const prefixedEntries = Object.entries(meta).filter(([key]) => key.startsWith("mux."));
  if (prefixedEntries.length === 0) {
    return undefined;
  }

  const flattened: Record<string, unknown> = {};
  for (const [key, value] of prefixedEntries) {
    flattened[key.slice("mux.".length)] = value;
  }

  return flattened;
}

export function parseMuxMeta(meta: Record<string, unknown> | null | undefined): MuxSessionMeta {
  const muxRecord = resolveMuxMetaRecord(meta);
  if (!muxRecord) {
    return {};
  }

  const parsed: MuxSessionMeta = {
    trunkBranch: getTrimmedString(muxRecord, "trunkBranch"),
    branchName: getTrimmedString(muxRecord, "branchName"),
    title: getTrimmedString(muxRecord, "title"),
    sectionId: getTrimmedString(muxRecord, "sectionId"),
    modeId: getTrimmedString(muxRecord, "modeId"),
    modelId: getTrimmedString(muxRecord, "modelId"),
    thinkingLevel: getTrimmedString(muxRecord, "thinkingLevel"),
  };

  if (parsed.modelId) {
    parsed.modelId = resolveModelAlias(parsed.modelId);
  }

  if (parsed.thinkingLevel) {
    const normalized = parsed.thinkingLevel.toLowerCase();
    const parsedThinking = parseThinkingDisplayLabel(normalized);
    if (!parsedThinking) {
      throw new Error(
        `Invalid _meta.mux.thinkingLevel "${parsed.thinkingLevel}"; expected off|low|med|medium|high|max|xhigh`
      );
    }
    parsed.thinkingLevel = parsedThinking;
  }

  const runtimeConfigRaw = muxRecord.runtimeConfig;
  if (runtimeConfigRaw != null) {
    const runtimeConfigResult = RuntimeConfigSchema.safeParse(runtimeConfigRaw);
    if (!runtimeConfigResult.success) {
      throw new Error("Invalid _meta.mux.runtimeConfig payload");
    }
    parsed.runtimeConfig = runtimeConfigResult.data;
  }

  return parsed;
}

function ensureAbsolutePath(cwd: string): string {
  const trimmed = cwd.trim();
  assert(trimmed.length > 0, "Session cwd must be non-empty");
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`Session cwd must be an absolute path: ${cwd}`);
  }
  return trimmed;
}

function canonicalizeAbsolutePathForComparison(inputPath: string): string {
  const absolutePath = ensureAbsolutePath(inputPath);
  const normalizedPath = path.resolve(path.normalize(absolutePath));
  return process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
}

function tryCanonicalizeAbsolutePathForComparison(
  inputPath: string | undefined
): string | undefined {
  if (typeof inputPath !== "string") {
    return undefined;
  }

  try {
    return canonicalizeAbsolutePathForComparison(inputPath);
  } catch {
    // Self-healing: persisted workspace metadata may contain malformed paths
    // (legacy/corrupted namedWorkspacePath). Ignore invalid entries instead of
    // failing the entire ACP ownership/list operation.
    return undefined;
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFallbackBranchName(): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `acp-${timestamp}-${randomSuffix}`.slice(0, 64);
}

function normalizeWorkspaceBranchName(branchName: string | undefined): string | undefined {
  const trimmed = branchName?.trim() ?? "";
  if (trimmed.length === 0) {
    return undefined;
  }

  // Workspace names must satisfy [a-z0-9_-]{1,64}. ACP clients commonly pass
  // git-style branch names like "feature/acp", so normalize separators and case
  // instead of failing session creation on backend validation.
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);

  const validation = validateWorkspaceName(normalized);
  return validation.valid ? normalized : undefined;
}

function resolveWorkspaceBranchName(branchName: string | undefined): string {
  return normalizeWorkspaceBranchName(branchName) ?? createFallbackBranchName();
}

type MCPAddInput =
  | {
      name: string;
      transport: "stdio";
      command: string;
    }
  | {
      name: string;
      transport: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
    };

interface MappedAcpMcpServer {
  name: string;
  addInput: MCPAddInput;
}

const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeAcpMcpServerName(name: string): string {
  const trimmed = name.trim();
  assert(trimmed.length > 0, "ACP MCP server names must be non-empty");
  return trimmed;
}

function mapAcpHttpHeaders(headers: schema.HttpHeader[]): Record<string, string> | undefined {
  if (headers.length === 0) {
    return undefined;
  }

  const mapped: Record<string, string> = {};
  for (const header of headers) {
    const normalizedName = header.name.trim();
    assert(normalizedName.length > 0, "ACP MCP header names must be non-empty");
    mapped[normalizedName] = header.value;
  }

  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function toShellCommandFromAcpStdioServer(server: schema.McpServerStdio): string {
  const command = server.command.trim();
  assert(command.length > 0, "ACP MCP stdio server command must be non-empty");

  const envPrefix = server.env
    .map((entry) => {
      const normalizedName = entry.name.trim();
      assert(normalizedName.length > 0, "ACP MCP env var names must be non-empty");
      assert(
        ENV_VAR_NAME_PATTERN.test(normalizedName),
        `ACP MCP env var name must match ${ENV_VAR_NAME_PATTERN.source}: ${normalizedName}`
      );
      return `${normalizedName}=${shellQuote(entry.value)}`;
    })
    .join(" ");

  const commandWithArgs = [command, ...server.args].map((segment) => shellQuote(segment)).join(" ");

  return envPrefix.length > 0 ? `${envPrefix} ${commandWithArgs}` : commandWithArgs;
}

function mapAcpMcpServer(server: schema.McpServer): MappedAcpMcpServer {
  const name = normalizeAcpMcpServerName(server.name);

  if ("type" in server) {
    const url = server.url.trim();
    assert(url.length > 0, `ACP MCP server "${name}" URL must be non-empty`);

    return {
      name,
      addInput: {
        name,
        transport: server.type,
        url,
        headers: mapAcpHttpHeaders(server.headers),
      },
    };
  }

  return {
    name,
    addInput: {
      name,
      transport: "stdio",
      command: toShellCommandFromAcpStdioServer(server),
    },
  };
}

function toSortedServerList(values: Iterable<string>): string[] | undefined {
  const sorted = Array.from(new Set(values)).sort();
  return sorted.length > 0 ? sorted : undefined;
}

function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

interface WorkspaceMcpOverrides {
  disabledServers?: string[];
  enabledServers?: string[];
  toolAllowlist?: Record<string, string[]>;
}

function normalizeWorkspaceMcpOverrides(overrides: WorkspaceMcpOverrides): WorkspaceMcpOverrides {
  return {
    ...overrides,
    enabledServers: toSortedServerList(overrides.enabledServers ?? []),
    disabledServers: toSortedServerList(overrides.disabledServers ?? []),
  };
}

async function applyAcpMcpServersToWorkspace(
  client: RouterClient<AppRouter>,
  params: {
    workspaceId: string;
    projectPath: string;
    mcpServers: schema.McpServer[] | undefined;
  }
): Promise<void> {
  const requestedServers = params.mcpServers ?? [];
  if (requestedServers.length === 0) {
    return;
  }

  const mappedServers = requestedServers.map(mapAcpMcpServer);

  const mappedByName = new Map<string, MappedAcpMcpServer>();
  for (const mapped of mappedServers) {
    if (mappedByName.has(mapped.name)) {
      throw new Error(`Duplicate ACP MCP server name: ${mapped.name}`);
    }
    mappedByName.set(mapped.name, mapped);
  }

  const existingServers = await client.mcp.list({ projectPath: params.projectPath });

  for (const mapped of mappedByName.values()) {
    if (existingServers[mapped.name]) {
      continue;
    }

    const addResult = await client.mcp.add(mapped.addInput);
    if (!addResult.success) {
      throw new Error(`Failed to add ACP MCP server "${mapped.name}": ${addResult.error}`);
    }

    // Keep ACP-provided servers disabled at global scope, then opt in only for
    // this workspace through overrides. This avoids leaking per-session servers
    // into unrelated workspaces.
    const disableResult = await client.mcp.setEnabled({
      name: mapped.name,
      enabled: false,
    });
    if (!disableResult.success) {
      throw new Error(
        `Failed to set ACP MCP server "${mapped.name}" disabled by default: ${disableResult.error}`
      );
    }
  }

  const currentWorkspaceOverrides = await client.workspace.mcp.get({
    workspaceId: params.workspaceId,
  });
  const currentOverrides = normalizeWorkspaceMcpOverrides(currentWorkspaceOverrides);

  const enabledServers = new Set(currentOverrides.enabledServers ?? []);
  const disabledServers = new Set(currentOverrides.disabledServers ?? []);

  for (const serverName of mappedByName.keys()) {
    enabledServers.add(serverName);
    disabledServers.delete(serverName);
  }

  const nextOverrides = normalizeWorkspaceMcpOverrides({
    ...currentOverrides,
    enabledServers: toSortedServerList(enabledServers),
    disabledServers: toSortedServerList(disabledServers),
  });

  if (
    areStringArraysEqual(currentOverrides.enabledServers, nextOverrides.enabledServers) &&
    areStringArraysEqual(currentOverrides.disabledServers, nextOverrides.disabledServers)
  ) {
    return;
  }

  const setResult = await client.workspace.mcp.set({
    workspaceId: params.workspaceId,
    overrides: nextOverrides,
  });

  if (!setResult.success) {
    throw new Error(`Failed to apply workspace MCP overrides: ${setResult.error}`);
  }
}

export function getWorkspaceAiSettings(
  metadata: FrontendWorkspaceMetadataSchemaType,
  modeId: SessionState["modeId"]
): {
  modelId: string;
  thinkingLevel: SessionState["thinkingLevel"];
} {
  const byAgent = metadata.aiSettingsByAgent?.[modeId];
  const settings = byAgent ?? metadata.aiSettings;

  return {
    modelId: resolveModelAlias(settings?.model ?? defaultModel),
    thinkingLevel: resolveThinkingLevel(settings?.thinkingLevel, "off"),
  };
}

interface BuildSessionStateParams {
  sessionId: string;
  workspaceId: string;
  projectPath: string;
  metadata: FrontendWorkspaceMetadataSchemaType;
  metaOverrides: MuxSessionMeta;
  fallback?: Pick<SessionState, "modeId" | "modelId" | "thinkingLevel">;
}

function buildSessionState(params: BuildSessionStateParams): SessionState {
  const fallbackMode = params.fallback?.modeId ?? resolveModeId(params.metadata.agentId, "exec");
  const modeId = resolveModeId(params.metaOverrides.modeId ?? fallbackMode, "exec");

  const persistedAiSettings = getWorkspaceAiSettings(params.metadata, modeId);

  const modelId = resolveModelAlias(
    params.metaOverrides.modelId ?? params.fallback?.modelId ?? persistedAiSettings.modelId
  );

  const thinkingLevel = resolveThinkingLevel(
    params.metaOverrides.thinkingLevel ??
      params.fallback?.thinkingLevel ??
      persistedAiSettings.thinkingLevel,
    "off"
  );

  // Resolve workspace-level base defaults (ignoring per-mode overrides) so
  // mode switches can fall back to the user's configured baseline rather
  // than hard-coded defaults when no per-mode entry exists.
  const baseSettings = params.metadata.aiSettings;
  const defaultModelId = resolveModelAlias(baseSettings?.model ?? defaultModel);
  const defaultThinkingLevel = resolveThinkingLevel(baseSettings?.thinkingLevel, "off");

  return {
    sessionId: params.sessionId,
    workspaceId: params.workspaceId,
    projectPath: params.projectPath,
    namedWorkspacePath: params.metadata.namedWorkspacePath,
    modeId,
    modelId,
    thinkingLevel,
    defaultModelId,
    defaultThinkingLevel,
    aiSettingsByAgent: params.metadata.aiSettingsByAgent
      ? { ...params.metadata.aiSettingsByAgent }
      : undefined,
  };
}

function assertWorkspaceBelongsToCwd(
  metadata: FrontendWorkspaceMetadataSchemaType,
  cwd: string
): void {
  const expectedPath = canonicalizeAbsolutePathForComparison(cwd);
  // Accept both the project path and the named worktree path as valid cwd values.
  // Clients may send either depending on whether they opened the project root
  // or the specific workspace directory (named worktree). Ignore malformed
  // persisted paths (e.g., corrupted legacy namedWorkspacePath) so valid
  // metadata.projectPath can still satisfy the ownership check.
  const validPaths = [
    tryCanonicalizeAbsolutePathForComparison(metadata.projectPath),
    tryCanonicalizeAbsolutePathForComparison(metadata.namedWorkspacePath),
  ].filter((candidate): candidate is string => typeof candidate === "string");

  if (!validPaths.includes(expectedPath)) {
    throw new Error(
      `Workspace ${metadata.id} belongs to ${metadata.projectPath}, but ACP requested cwd ${expectedPath}`
    );
  }
}

async function requireWorkspaceMetadata(
  client: RouterClient<AppRouter>,
  workspaceId: string
): Promise<FrontendWorkspaceMetadataSchemaType> {
  const metadata = await client.workspace.getInfo({ workspaceId });
  if (!metadata) {
    throw new Error(`Workspace not found for session ${workspaceId}`);
  }
  return metadata;
}

export async function createWorkspaceBackedSession(
  client: RouterClient<AppRouter>,
  params: schema.NewSessionRequest
): Promise<SessionState> {
  const projectPath = ensureAbsolutePath(params.cwd);
  const meta = parseMuxMeta(params._meta ?? undefined);

  const runtimeConfig = meta.runtimeConfig;

  let trunkBranch = meta.trunkBranch;
  if (!trunkBranch && (!runtimeConfig || runtimeConfig.type === "worktree")) {
    try {
      trunkBranch = await detectDefaultTrunkBranch(projectPath);
    } catch {
      // Best-effort auto-detection for local/worktree runtime paths. If detection fails,
      // allow backend validation to return the canonical creation error.
    }
  }

  // For non-local runtimes (worktree/ssh/etc.), the backend requires a trunk branch.
  // Let the backend pick its default runtime when runtimeConfig is omitted, but
  // proactively provide a detected trunk when available to keep session/new working.
  if (runtimeConfig && runtimeConfig.type !== "local" && !trunkBranch) {
    throw new Error(
      `Trunk branch (_meta.mux.trunkBranch) is required for non-local runtimes (type: "${runtimeConfig.type}"). ` +
        "Specify it in the session metadata or use a local runtime."
    );
  }

  const branchName = resolveWorkspaceBranchName(meta.branchName);

  const createResult = await client.workspace.create({
    projectPath,
    branchName,
    trunkBranch,
    title: meta.title,
    ...(runtimeConfig ? { runtimeConfig } : {}),
    sectionId: meta.sectionId,
  });

  if (!createResult.success) {
    throw new Error(`workspace.create failed: ${createResult.error}`);
  }

  try {
    await applyAcpMcpServersToWorkspace(client, {
      workspaceId: createResult.metadata.id,
      projectPath,
      mcpServers: params.mcpServers,
    });
  } catch (error) {
    const setupError = toErrorMessage(error);

    try {
      const rollbackResult = await client.workspace.remove({
        workspaceId: createResult.metadata.id,
        options: {
          force: true,
        },
      });

      if (!rollbackResult.success) {
        throw new Error(rollbackResult.error ?? "unknown error");
      }
    } catch (rollbackError) {
      throw new Error(
        `Failed to apply ACP MCP configuration: ${setupError}. ` +
          `Rollback failed for workspace ${createResult.metadata.id}: ${toErrorMessage(rollbackError)}`
      );
    }

    throw new Error(
      `Failed to apply ACP MCP configuration: ${setupError}. ` +
        `Workspace ${createResult.metadata.id} was removed to avoid orphaned state.`
    );
  }

  return buildSessionState({
    sessionId: createResult.metadata.id,
    workspaceId: createResult.metadata.id,
    projectPath,
    metadata: createResult.metadata,
    metaOverrides: meta,
  });
}

export async function loadWorkspaceBackedSession(
  client: RouterClient<AppRouter>,
  params: schema.LoadSessionRequest
): Promise<SessionState> {
  const metadata = await requireWorkspaceMetadata(client, params.sessionId);
  assertWorkspaceBelongsToCwd(metadata, params.cwd);

  const meta = parseMuxMeta(params._meta ?? undefined);

  await applyAcpMcpServersToWorkspace(client, {
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    mcpServers: params.mcpServers,
  });

  return buildSessionState({
    sessionId: params.sessionId,
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    metadata,
    metaOverrides: meta,
  });
}

export async function resumeWorkspaceBackedSession(
  client: RouterClient<AppRouter>,
  params: schema.ResumeSessionRequest
): Promise<SessionState> {
  const metadata = await requireWorkspaceMetadata(client, params.sessionId);
  assertWorkspaceBelongsToCwd(metadata, params.cwd);

  const meta = parseMuxMeta(params._meta ?? undefined);

  await applyAcpMcpServersToWorkspace(client, {
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    mcpServers: params.mcpServers,
  });

  return buildSessionState({
    sessionId: params.sessionId,
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    metadata,
    metaOverrides: meta,
  });
}

export async function forkWorkspaceBackedSession(
  client: RouterClient<AppRouter>,
  params: schema.ForkSessionRequest,
  sourceSession: SessionState | undefined
): Promise<SessionState> {
  const sourceWorkspaceId = sourceSession?.workspaceId ?? params.sessionId;
  const sourceMetadata = await requireWorkspaceMetadata(client, sourceWorkspaceId);

  assertWorkspaceBelongsToCwd(sourceMetadata, params.cwd);

  const meta = parseMuxMeta(params._meta ?? undefined);

  const normalizedForkName = normalizeWorkspaceBranchName(meta.branchName);

  const forkResult = await client.workspace.fork({
    sourceWorkspaceId,
    newName: normalizedForkName,
  });

  if (!forkResult.success) {
    throw new Error(`workspace.fork failed: ${forkResult.error}`);
  }

  await applyAcpMcpServersToWorkspace(client, {
    workspaceId: forkResult.metadata.id,
    projectPath: forkResult.projectPath,
    mcpServers: params.mcpServers,
  });

  return buildSessionState({
    sessionId: forkResult.metadata.id,
    workspaceId: forkResult.metadata.id,
    projectPath: forkResult.projectPath,
    metadata: forkResult.metadata,
    metaOverrides: meta,
    fallback: sourceSession,
  });
}

function parseCursorOffset(cursor: string | null | undefined): number {
  if (cursor == null || cursor.trim().length === 0) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid session/list cursor: ${cursor}`);
  }

  return parsed;
}

function resolveWorkspaceUpdatedAt(
  metadata: FrontendWorkspaceMetadataSchemaType
): string | undefined {
  const candidates = [metadata.unarchivedAt, metadata.archivedAt, metadata.createdAt].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );

  if (candidates.length === 0) {
    return undefined;
  }

  let latestTimestamp = Number.NEGATIVE_INFINITY;
  let latestValue = candidates[0];

  for (const candidate of candidates) {
    const parsed = parseWorkspaceTimestamp(candidate);
    if (parsed >= latestTimestamp) {
      latestTimestamp = parsed;
      latestValue = candidate;
    }
  }

  return latestValue;
}

function parseWorkspaceTimestamp(value: string | undefined): number {
  if (typeof value !== "string" || value.length === 0) {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toSessionInfo(metadata: FrontendWorkspaceMetadataSchemaType): schema.SessionInfo {
  const info: schema.SessionInfo = {
    sessionId: metadata.id,
    cwd: metadata.projectPath,
    title: metadata.title ?? metadata.name,
  };

  const updatedAt = resolveWorkspaceUpdatedAt(metadata);
  if (updatedAt) {
    info.updatedAt = updatedAt;
  }

  return info;
}

export async function listWorkspaceBackedSessions(
  client: RouterClient<AppRouter>,
  params: schema.ListSessionsRequest
): Promise<schema.ListSessionsResponse> {
  const allWorkspaces = await client.workspace.list();

  const filtered = params.cwd
    ? (() => {
        const expectedCwd = canonicalizeAbsolutePathForComparison(params.cwd);
        return allWorkspaces.filter((workspace) => {
          const workspacePaths = [
            tryCanonicalizeAbsolutePathForComparison(workspace.projectPath),
            tryCanonicalizeAbsolutePathForComparison(workspace.namedWorkspacePath),
          ];

          return workspacePaths.includes(expectedCwd);
        });
      })()
    : allWorkspaces;

  const sorted = [...filtered].sort((left, right) => {
    const leftTime = parseWorkspaceTimestamp(resolveWorkspaceUpdatedAt(left));
    const rightTime = parseWorkspaceTimestamp(resolveWorkspaceUpdatedAt(right));
    return rightTime - leftTime;
  });

  const offset = parseCursorOffset(params.cursor);
  const page = sorted.slice(offset, offset + LIST_PAGE_SIZE);

  return {
    sessions: page.map(toSessionInfo),
    nextCursor: offset + LIST_PAGE_SIZE < sorted.length ? String(offset + LIST_PAGE_SIZE) : null,
  };
}
