import * as path from "path";
import type * as schema from "@agentclientprotocol/sdk";
import type { RouterClient } from "@orpc/server";
import { RuntimeConfigSchema } from "@/common/orpc/schemas";
import type { FrontendWorkspaceMetadataSchemaType } from "@/common/orpc/types";
import type { RuntimeConfig } from "@/common/types/runtime";
import { parseThinkingDisplayLabel } from "@/common/types/thinking";
import { defaultModel, resolveModelAlias } from "@/common/utils/ai/models";
import assert from "@/common/utils/assert";
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

function createFallbackBranchName(): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `acp-${timestamp}-${randomSuffix}`.slice(0, 64);
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
  const expectedPath = ensureAbsolutePath(cwd);
  // Accept both the project path and the named worktree path as valid cwd values.
  // Clients may send either depending on whether they opened the project root
  // or the specific workspace directory (named worktree).
  const validPaths = [metadata.projectPath, metadata.namedWorkspacePath];
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

  const runtimeConfig: RuntimeConfig = meta.runtimeConfig ?? { type: "local" };
  // For non-local runtimes (worktree/ssh/etc.), the backend requires a trunk branch.
  // Let the backend detect it for local runtimes when not specified, rather than
  // assuming "main" — repositories may use "master" or other branch naming conventions.
  const trunkBranch = meta.trunkBranch;
  if (runtimeConfig.type !== "local" && !trunkBranch) {
    throw new Error(
      `Trunk branch (_meta.mux.trunkBranch) is required for non-local runtimes (type: "${runtimeConfig.type}"). ` +
        "Specify it in the session metadata or use a local runtime."
    );
  }

  const createResult = await client.workspace.create({
    projectPath,
    branchName: meta.branchName ?? createFallbackBranchName(),
    trunkBranch,
    title: meta.title,
    runtimeConfig,
    sectionId: meta.sectionId,
  });

  if (!createResult.success) {
    throw new Error(`workspace.create failed: ${createResult.error}`);
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

  const forkResult = await client.workspace.fork({
    sourceWorkspaceId,
    newName: meta.branchName,
  });

  if (!forkResult.success) {
    throw new Error(`workspace.fork failed: ${forkResult.error}`);
  }

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

function toSessionInfo(metadata: FrontendWorkspaceMetadataSchemaType): schema.SessionInfo {
  const info: schema.SessionInfo = {
    sessionId: metadata.id,
    cwd: metadata.projectPath,
    title: metadata.title ?? metadata.name,
  };

  const updatedAt = metadata.unarchivedAt ?? metadata.archivedAt ?? metadata.createdAt;
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
    ? allWorkspaces.filter(
        (workspace) =>
          workspace.projectPath === params.cwd || workspace.namedWorkspacePath === params.cwd
      )
    : allWorkspaces;

  const sorted = [...filtered].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt ?? "") || 0;
    const rightTime = Date.parse(right.createdAt ?? "") || 0;
    return rightTime - leftTime;
  });

  const offset = parseCursorOffset(params.cursor);
  const page = sorted.slice(offset, offset + LIST_PAGE_SIZE);

  return {
    sessions: page.map(toSessionInfo),
    nextCursor: offset + LIST_PAGE_SIZE < sorted.length ? String(offset + LIST_PAGE_SIZE) : null,
  };
}
