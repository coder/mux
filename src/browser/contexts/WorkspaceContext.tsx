import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ThinkingLevel } from "@/common/types/thinking";
import type { WorkspaceSelection } from "@/browser/components/ProjectSidebar";
import type { RuntimeConfig } from "@/common/types/runtime";
import type { MuxDeepLinkPayload } from "@/common/types/deepLink";
import { MUX_HELP_CHAT_WORKSPACE_ID } from "@/common/constants/muxChat";
import {
  deleteWorkspaceStorage,
  getAgentIdKey,
  getDraftScopeId,
  getInputAttachmentsKey,
  getInputKey,
  getModelKey,
  getPendingScopeId,
  getThinkingLevelKey,
  getWorkspaceAISettingsByAgentKey,
  getWorkspaceNameStateKey,
  migrateWorkspaceStorage,
  AGENT_AI_DEFAULTS_KEY,
  DEFAULT_MODEL_KEY,
  GATEWAY_ENABLED_KEY,
  GATEWAY_MODELS_KEY,
  HIDDEN_MODELS_KEY,
  PREFERRED_COMPACTION_MODEL_KEY,
  SELECTED_WORKSPACE_KEY,
  WORKSPACE_DRAFTS_BY_PROJECT_KEY,
} from "@/common/constants/storage";
import { useAPI } from "@/browser/contexts/API";
import { setWorkspaceModelWithOrigin } from "@/browser/utils/modelChange";
import {
  readPersistedState,
  readPersistedString,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { useProjectContext } from "@/browser/contexts/ProjectContext";
import { useWorkspaceStoreRaw } from "@/browser/stores/WorkspaceStore";
import { normalizeAgentAiDefaults } from "@/common/types/agentAiDefaults";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { getProjectRouteId } from "@/common/utils/projectRouteId";
import { resolveProjectPathFromProjectQuery } from "@/common/utils/deepLink";
import { shouldApplyWorkspaceAiSettingsFromBackend } from "@/browser/utils/workspaceAiSettingsSync";
import { isAbortError } from "@/browser/utils/isAbortError";
import { findAdjacentWorkspaceId } from "@/browser/utils/ui/workspaceDomNav";
import { useRouter } from "@/browser/contexts/RouterContext";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import type { APIClient } from "@/browser/contexts/API";
import { getErrorMessage } from "@/common/utils/errors";

/**
 * One-time best-effort migration: if the backend doesn't have model preferences yet,
 * persist non-default localStorage values so future port/origin changes keep them.
 * Called once on startup after backend config is fetched.
 */
function migrateLocalModelPrefsToBackend(
  api: APIClient,
  cfg: { defaultModel?: string; hiddenModels?: string[]; preferredCompactionModel?: string }
): void {
  if (!api.config.updateModelPreferences) return;

  const localDefaultModelRaw = readPersistedString(DEFAULT_MODEL_KEY);
  const localDefaultModel =
    typeof localDefaultModelRaw === "string"
      ? migrateGatewayModel(localDefaultModelRaw).trim()
      : undefined;
  const localHiddenModels = readPersistedState<string[] | null>(HIDDEN_MODELS_KEY, null);
  const localPreferredCompactionModel = readPersistedString(PREFERRED_COMPACTION_MODEL_KEY);

  const patch: {
    defaultModel?: string;
    hiddenModels?: string[];
    preferredCompactionModel?: string;
  } = {};

  if (
    cfg.defaultModel === undefined &&
    localDefaultModel &&
    localDefaultModel !== WORKSPACE_DEFAULTS.model
  ) {
    patch.defaultModel = localDefaultModel;
  }

  if (
    cfg.hiddenModels === undefined &&
    Array.isArray(localHiddenModels) &&
    localHiddenModels.length > 0
  ) {
    patch.hiddenModels = localHiddenModels;
  }

  if (
    cfg.preferredCompactionModel === undefined &&
    typeof localPreferredCompactionModel === "string" &&
    localPreferredCompactionModel.trim()
  ) {
    patch.preferredCompactionModel = localPreferredCompactionModel;
  }

  if (Object.keys(patch).length > 0) {
    api.config.updateModelPreferences(patch).catch(() => {
      // Best-effort only.
    });
  }
}

/**
 * Seed per-workspace localStorage from backend workspace metadata.
 *
 * This keeps a workspace's model/thinking consistent across devices/browsers.
 */
function seedWorkspaceLocalStorageFromBackend(metadata: FrontendWorkspaceMetadata): void {
  // Cache keyed by agentId (string) - includes exec, plan, and custom agents
  type WorkspaceAISettingsByAgentCache = Partial<
    Record<string, { model: string; thinkingLevel: ThinkingLevel }>
  >;

  const workspaceId = metadata.id;

  // Seed the workspace agentId (tasks/subagents) so the UI renders correctly on reload.
  // Main workspaces default to the locally-selected agentId (stored in localStorage).
  const metadataAgentId = metadata.agentId ?? metadata.agentType;
  if (typeof metadataAgentId === "string" && metadataAgentId.trim().length > 0) {
    const key = getAgentIdKey(workspaceId);
    const normalized = metadataAgentId.trim().toLowerCase();
    const existing = readPersistedState<string | undefined>(key, undefined);
    if (existing !== normalized) {
      updatePersistedState(key, normalized);
    }
  }

  const aiByAgent =
    metadata.aiSettingsByAgent ??
    (metadata.aiSettings
      ? {
          plan: metadata.aiSettings,
          exec: metadata.aiSettings,
        }
      : undefined);

  if (!aiByAgent) {
    return;
  }

  // Merge backend values into a per-workspace per-agent cache.
  const byAgentKey = getWorkspaceAISettingsByAgentKey(workspaceId);
  const existingByAgent = readPersistedState<WorkspaceAISettingsByAgentCache>(byAgentKey, {});
  const nextByAgent: WorkspaceAISettingsByAgentCache = { ...existingByAgent };

  for (const [agentKey, entry] of Object.entries(aiByAgent)) {
    if (!entry) continue;
    if (typeof entry.model !== "string" || entry.model.length === 0) continue;

    // Protect newer local preferences from stale metadata updates (e.g., rapid thinking toggles).
    if (
      !shouldApplyWorkspaceAiSettingsFromBackend(workspaceId, agentKey, {
        model: entry.model,
        thinkingLevel: entry.thinkingLevel,
      })
    ) {
      continue;
    }

    nextByAgent[agentKey] = {
      model: entry.model,
      thinkingLevel: entry.thinkingLevel,
    };
  }

  if (JSON.stringify(existingByAgent) !== JSON.stringify(nextByAgent)) {
    updatePersistedState(byAgentKey, nextByAgent);
  }

  // Seed the active agent into the existing keys to avoid UI flash.
  const activeAgentId = readPersistedState<string>(getAgentIdKey(workspaceId), "exec");
  const active = nextByAgent[activeAgentId] ?? nextByAgent.exec ?? nextByAgent.plan;
  if (!active) {
    return;
  }

  const modelKey = getModelKey(workspaceId);
  const existingModel = readPersistedState<string | undefined>(modelKey, undefined);
  if (existingModel !== active.model) {
    setWorkspaceModelWithOrigin(workspaceId, active.model, "sync");
  }

  const thinkingKey = getThinkingLevelKey(workspaceId);
  const existingThinking = readPersistedState<ThinkingLevel | undefined>(thinkingKey, undefined);
  if (existingThinking !== active.thinkingLevel) {
    updatePersistedState(thinkingKey, active.thinkingLevel);
  }
}

export function toWorkspaceSelection(metadata: FrontendWorkspaceMetadata): WorkspaceSelection {
  return {
    workspaceId: metadata.id,
    projectPath: metadata.projectPath,
    projectName: metadata.projectName,
    namedWorkspacePath: metadata.namedWorkspacePath,
  };
}

/**
 * Ensure workspace metadata has createdAt timestamp.
 * DEFENSIVE: Backend guarantees createdAt, but default to 2025-01-01 if missing.
 * This prevents crashes if backend contract is violated.
 */
function ensureCreatedAt(metadata: FrontendWorkspaceMetadata): void {
  if (!metadata.createdAt) {
    console.warn(
      `[Frontend] Workspace ${metadata.id} missing createdAt - using default (2025-01-01)`
    );
    metadata.createdAt = "2025-01-01T00:00:00.000Z";
  }
}

export interface WorkspaceDraft {
  draftId: string;
  sectionId: string | null;
  createdAt: number;
}

type WorkspaceDraftsByProject = Record<string, WorkspaceDraft[]>;

type WorkspaceDraftPromotionsByProject = Record<string, Record<string, FrontendWorkspaceMetadata>>;

function isWorkspaceDraft(value: unknown): value is WorkspaceDraft {
  if (!value || typeof value !== "object") return false;

  const record = value as { draftId?: unknown; sectionId?: unknown; createdAt?: unknown };
  return (
    typeof record.draftId === "string" &&
    record.draftId.trim().length > 0 &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    (record.sectionId === null ||
      record.sectionId === undefined ||
      typeof record.sectionId === "string")
  );
}

function normalizeWorkspaceDraftsByProject(value: unknown): WorkspaceDraftsByProject {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: WorkspaceDraftsByProject = {};

  for (const [projectPath, drafts] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(drafts)) continue;

    const nextDrafts: WorkspaceDraft[] = [];
    for (const draft of drafts) {
      if (!isWorkspaceDraft(draft)) continue;

      const normalizedSectionId =
        typeof draft.sectionId === "string" && draft.sectionId.trim().length > 0
          ? draft.sectionId
          : null;

      nextDrafts.push({
        draftId: draft.draftId,
        sectionId: normalizedSectionId,
        createdAt: draft.createdAt,
      });
    }

    if (nextDrafts.length > 0) {
      result[projectPath] = nextDrafts;
    }
  }

  return result;
}

function normalizeProjectPathForComparison(projectPath: string): string {
  let normalized = projectPath.trim();

  // Be forgiving: mux:// links may include trailing path separators.
  normalized = normalized.replace(/[\\/]+$/, "");

  // Paths are case-insensitive on Windows.
  if (globalThis.window?.api?.platform === "win32") {
    normalized = normalized.toLowerCase();
  }

  return normalized;
}

function createWorkspaceDraftId(): string {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto && typeof maybeCrypto.randomUUID === "function") {
    const id = maybeCrypto.randomUUID();
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }

  return `draft_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * Check if a draft workspace is empty (no input text, no attachments, and no workspace name set).
 * An empty draft can be reused when the user clicks "New Workspace" instead of creating another.
 */
function isDraftEmpty(projectPath: string, draftId: string): boolean {
  const scopeId = getDraftScopeId(projectPath, draftId);

  // Check for input text
  const inputText = readPersistedState<string>(getInputKey(scopeId), "");
  if (inputText.trim().length > 0) {
    return false;
  }

  // Check for attachments
  const attachments = readPersistedState<unknown[]>(getInputAttachmentsKey(scopeId), []);
  if (Array.isArray(attachments) && attachments.length > 0) {
    return false;
  }

  // Check for workspace name state (auto-generated or manual)
  const nameState = readPersistedState<unknown>(getWorkspaceNameStateKey(scopeId), null);
  if (nameState !== null) {
    return false;
  }

  return true;
}

/**
 * Find an existing empty draft for a project (optionally within a specific section).
 * Returns the draft ID if found, or null if no empty draft exists.
 */
function findExistingEmptyDraft(
  workspaceDrafts: WorkspaceDraft[],
  projectPath: string,
  sectionId?: string
): string | null {
  const normalizedSectionId = sectionId ?? null;

  for (const draft of workspaceDrafts) {
    // Keep draft reuse scoped to the current section. When sectionId is undefined
    // (project-level "New Workspace"), only reuse drafts with a null section so
    // we don't silently move section-specific drafts into the root flow.
    if ((draft.sectionId ?? null) !== normalizedSectionId) {
      continue;
    }
    if (isDraftEmpty(projectPath, draft.draftId)) {
      return draft.draftId;
    }
  }
  return null;
}

// ─── Metadata context (changes on every workspace create/archive/rename) ─────
// Separated so components that only need actions/selection don't re-render on
// metadata map changes.

export interface WorkspaceMetadataContextValue {
  workspaceMetadata: Map<string, FrontendWorkspaceMetadata>;
  loading: boolean;
}

const WorkspaceMetadataContext = createContext<WorkspaceMetadataContextValue | undefined>(
  undefined
);

// ─── Actions context (stable unless selection/drafts change) ─────────────────

export interface WorkspaceContext extends WorkspaceMetadataContextValue {
  // UI-only draft workspace promotions (draftId -> created workspace).
  // This is intentionally ephemeral: it makes the sidebar feel like the draft
  // "turns into" the created workspace, but doesn't pin ordering permanently.
  workspaceDraftPromotionsByProject: WorkspaceDraftPromotionsByProject;
  promoteWorkspaceDraft: (
    projectPath: string,
    draftId: string,
    metadata: FrontendWorkspaceMetadata
  ) => void;

  // Workspace operations
  createWorkspace: (
    projectPath: string,
    branchName: string,
    trunkBranch: string,
    runtimeConfig?: RuntimeConfig
  ) => Promise<{
    projectPath: string;
    projectName: string;
    namedWorkspacePath: string;
    workspaceId: string;
  }>;
  removeWorkspace: (
    workspaceId: string,
    options?: { force?: boolean }
  ) => Promise<{ success: boolean; error?: string }>;
  updateWorkspaceTitle: (
    workspaceId: string,
    newTitle: string
  ) => Promise<{ success: boolean; error?: string }>;
  archiveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  unarchiveWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  refreshWorkspaceMetadata: () => Promise<void>;
  setWorkspaceMetadata: React.Dispatch<
    React.SetStateAction<Map<string, FrontendWorkspaceMetadata>>
  >;

  // Selection
  selectedWorkspace: WorkspaceSelection | null;
  setSelectedWorkspace: React.Dispatch<React.SetStateAction<WorkspaceSelection | null>>;

  // Workspace creation flow
  pendingNewWorkspaceProject: string | null;
  /** Section ID to pre-select when creating a new workspace (from URL) */
  pendingNewWorkspaceSectionId: string | null;
  /** Draft ID to open when creating a UI-only workspace draft (from URL) */
  pendingNewWorkspaceDraftId: string | null;
  /** Legacy entry point: open the creation screen (no new draft is created) */
  beginWorkspaceCreation: (projectPath: string, sectionId?: string) => void;

  // UI-only workspace creation drafts (placeholders)
  workspaceDraftsByProject: WorkspaceDraftsByProject;
  createWorkspaceDraft: (projectPath: string, sectionId?: string) => void;
  updateWorkspaceDraftSection: (
    projectPath: string,
    draftId: string,
    sectionId: string | null
  ) => void;
  openWorkspaceDraft: (projectPath: string, draftId: string, sectionId?: string | null) => void;
  deleteWorkspaceDraft: (projectPath: string, draftId: string) => void;

  // Helpers
  getWorkspaceInfo: (workspaceId: string) => Promise<FrontendWorkspaceMetadata | null>;
}

const WorkspaceActionsContext = createContext<
  Omit<WorkspaceContext, "workspaceMetadata" | "loading"> | undefined
>(undefined);

interface WorkspaceProviderProps {
  children: ReactNode;
}

export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const { api } = useAPI();

  // Cache global agent defaults (plus legacy mode defaults) so non-react code paths can read them.
  useEffect(() => {
    if (!api?.config?.getConfig) return;

    void api.config
      .getConfig()
      .then((cfg) => {
        updatePersistedState(
          AGENT_AI_DEFAULTS_KEY,
          normalizeAgentAiDefaults(cfg.agentAiDefaults ?? {})
        );

        // Seed Mux Gateway prefs from backend so switching ports doesn't reset the UI.
        if (cfg.muxGatewayEnabled !== undefined) {
          updatePersistedState(GATEWAY_ENABLED_KEY, cfg.muxGatewayEnabled);
        }
        if (cfg.muxGatewayModels !== undefined) {
          updatePersistedState(GATEWAY_MODELS_KEY, cfg.muxGatewayModels);
        }

        // Seed global model preferences from backend so switching ports doesn't reset the UI.
        if (cfg.defaultModel !== undefined) {
          updatePersistedState(DEFAULT_MODEL_KEY, cfg.defaultModel);
        }
        if (cfg.hiddenModels !== undefined) {
          updatePersistedState(HIDDEN_MODELS_KEY, cfg.hiddenModels);
        }
        if (cfg.preferredCompactionModel !== undefined) {
          updatePersistedState(PREFERRED_COMPACTION_MODEL_KEY, cfg.preferredCompactionModel);
        }

        // One-time best-effort migration: if the backend doesn't have gateway prefs yet,
        // persist non-default localStorage values so future port changes keep them.
        if (api.config.updateMuxGatewayPrefs) {
          const localEnabled = readPersistedState<boolean>(GATEWAY_ENABLED_KEY, true);
          const localModels = readPersistedState<string[]>(GATEWAY_MODELS_KEY, []);

          const shouldMigrateEnabled =
            cfg.muxGatewayEnabled === undefined && localEnabled === false;
          const shouldMigrateModels = cfg.muxGatewayModels === undefined && localModels.length > 0;

          if (shouldMigrateEnabled || shouldMigrateModels) {
            api.config
              .updateMuxGatewayPrefs({
                muxGatewayEnabled: cfg.muxGatewayEnabled ?? localEnabled,
                muxGatewayModels: cfg.muxGatewayModels ?? localModels,
              })
              .catch(() => {
                // Best-effort only.
              });
          }
        }

        // One-time best-effort migration: if the backend doesn't have model prefs yet,
        // persist non-default localStorage values so future port changes keep them.
        migrateLocalModelPrefsToBackend(api, cfg);
      })
      .catch(() => {
        // Best-effort only.
      });
  }, [api]);
  // Get project refresh function from ProjectContext
  const { projects, refreshProjects, loading: projectsLoading } = useProjectContext();
  // Get router navigation functions and current route state
  const {
    navigateToWorkspace,
    navigateToProject,
    navigateToHome,
    currentWorkspaceId,
    currentProjectId,
    currentProjectPathFromState,
    currentSettingsSection,
    pendingSectionId,
    pendingDraftId,
  } = useRouter();

  const workspaceStore = useWorkspaceStoreRaw();
  const [workspaceMetadata, setWorkspaceMetadataState] = useState<
    Map<string, FrontendWorkspaceMetadata>
  >(new Map());
  const setWorkspaceMetadata = useCallback(
    (update: SetStateAction<Map<string, FrontendWorkspaceMetadata>>) => {
      setWorkspaceMetadataState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        // IMPORTANT: Sync the imperative WorkspaceStore first so hooks (AIView,
        // LeftSidebar, etc.) never render with a selected workspace ID before
        // the store has subscribed and created its aggregator. Otherwise the
        // render path hits WorkspaceStore.assertGet() and throws the
        // "Workspace <id> not found - must call addWorkspace() first" assert.
        workspaceStore.syncWorkspaces(next);
        return next;
      });
    },
    [workspaceStore]
  );
  const [loading, setLoading] = useState(true);

  const [workspaceDraftPromotionsByProject, setWorkspaceDraftPromotionsByProject] =
    useState<WorkspaceDraftPromotionsByProject>({});
  const [workspaceDraftsByProjectState, setWorkspaceDraftsByProjectState] =
    usePersistedState<WorkspaceDraftsByProject>(
      WORKSPACE_DRAFTS_BY_PROJECT_KEY,
      {},
      { listener: true }
    );

  const workspaceDraftsByProject = useMemo(
    () => normalizeWorkspaceDraftsByProject(workspaceDraftsByProjectState),
    [workspaceDraftsByProjectState]
  );

  const pendingDeepLinksRef = useRef<MuxDeepLinkPayload[]>([]);

  const handleDeepLink = useCallback(
    (payload: MuxDeepLinkPayload) => {
      if (payload.type !== "new_chat") {
        return;
      }

      let resolvedProjectPath: string | null = null;

      const projectPathFromPayload =
        typeof payload.projectPath === "string" && payload.projectPath.trim().length > 0
          ? payload.projectPath
          : null;

      if (projectPathFromPayload) {
        const target = normalizeProjectPathForComparison(projectPathFromPayload);

        for (const projectPath of projects.keys()) {
          if (normalizeProjectPathForComparison(projectPath) === target) {
            resolvedProjectPath = projectPath;
            break;
          }
        }
      }

      const projectIdFromPayload =
        resolvedProjectPath === null &&
        typeof payload.projectId === "string" &&
        payload.projectId.trim().length > 0
          ? payload.projectId
          : null;

      if (projectIdFromPayload) {
        for (const projectPath of projects.keys()) {
          if (getProjectRouteId(projectPath) === projectIdFromPayload) {
            resolvedProjectPath = projectPath;
            break;
          }
        }
      }

      const projectQueryFromPayload =
        resolvedProjectPath === null &&
        typeof payload.project === "string" &&
        payload.project.trim().length > 0
          ? payload.project
          : null;

      // Back-compat/ergonomics: if a deep link passed a projectPath that doesn't match
      // exactly (e.g., different machine), still try matching by its final path segment.
      const inferredProjectQueryFromPath =
        resolvedProjectPath === null && projectQueryFromPayload === null && projectPathFromPayload
          ? projectPathFromPayload
          : null;

      const projectQuery = projectQueryFromPayload ?? inferredProjectQueryFromPath;
      if (resolvedProjectPath === null && projectQuery) {
        resolvedProjectPath = resolveProjectPathFromProjectQuery(projects.keys(), projectQuery);
      }

      // If no project is specified (or matching failed), default to the first project in the list.
      if (resolvedProjectPath === null) {
        const firstProjectPath = projects.keys().next().value;
        if (typeof firstProjectPath === "string") {
          resolvedProjectPath = firstProjectPath;
        }
      }

      if (!resolvedProjectPath) {
        // Startup deep links can arrive before the projects list is populated.
        //
        // NOTE: ProjectContext can set `projectsLoading=false` even when the API isn't
        // connected yet (refreshProjects() returns early but the effect still flips loading).
        // In that window, buffer unresolved links in-memory and retry once projects load.
        const shouldBuffer = projectsLoading || !api || projects.size === 0;
        if (shouldBuffer) {
          const queue = pendingDeepLinksRef.current;
          if (queue.length >= 10) {
            queue.shift();
          }
          queue.push(payload);
        }
        return;
      }

      const normalizedSectionId =
        typeof payload.sectionId === "string" && payload.sectionId.trim().length > 0
          ? payload.sectionId
          : null;

      // IMPORTANT: Deep links should always create a fresh draft, even if an existing draft
      // is empty. This keeps deep-link navigations predictable and avoids surprising reuse.
      const draftId = createWorkspaceDraftId();
      const createdAt = Date.now();

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[resolvedProjectPath] ?? [];

        return {
          ...current,
          [resolvedProjectPath]: [
            ...existing,
            {
              draftId,
              sectionId: normalizedSectionId,
              createdAt,
            },
          ],
        };
      });

      const prompt =
        typeof payload.prompt === "string" && payload.prompt.trim().length > 0
          ? payload.prompt
          : null;

      if (prompt) {
        updatePersistedState(getInputKey(getDraftScopeId(resolvedProjectPath, draftId)), prompt);
      }

      navigateToProject(resolvedProjectPath, normalizedSectionId ?? undefined, draftId);
    },
    [api, navigateToProject, projects, projectsLoading, setWorkspaceDraftsByProjectState]
  );

  const deepLinkHandlerRef = useRef(handleDeepLink);
  deepLinkHandlerRef.current = handleDeepLink;

  useEffect(() => {
    const unsubscribe = window.api?.onDeepLink?.((payload) => {
      deepLinkHandlerRef.current(payload);
    });

    const pending = window.api?.consumePendingDeepLinks?.() ?? [];
    for (const payload of pending) {
      deepLinkHandlerRef.current(payload);
    }

    return () => {
      unsubscribe?.();
    };
  }, [deepLinkHandlerRef]);

  useEffect(() => {
    if (pendingDeepLinksRef.current.length === 0) {
      return;
    }

    const queued = pendingDeepLinksRef.current;
    pendingDeepLinksRef.current = [];

    for (const payload of queued) {
      deepLinkHandlerRef.current(payload);
    }
  }, [projects, projectsLoading, deepLinkHandlerRef]);

  // Clean up promotions that point at removed drafts or archived workspaces so
  // promoted entries never hide the real workspace list.
  useEffect(() => {
    if (loading) {
      return;
    }

    setWorkspaceDraftPromotionsByProject((prev) => {
      let changed = false;
      const next: WorkspaceDraftPromotionsByProject = {};

      for (const [projectPath, promotions] of Object.entries(prev)) {
        const draftIds = new Set(
          (workspaceDraftsByProject[projectPath] ?? []).map((draft) => draft.draftId)
        );
        if (draftIds.size === 0) {
          if (Object.keys(promotions).length > 0) {
            changed = true;
          }
          continue;
        }

        const nextPromotions: Record<string, FrontendWorkspaceMetadata> = {};
        for (const [draftId, metadata] of Object.entries(promotions)) {
          if (!draftIds.has(draftId)) {
            changed = true;
            continue;
          }

          const liveMetadata = workspaceMetadata.get(metadata.id);
          if (!liveMetadata) {
            changed = true;
            continue;
          }

          nextPromotions[draftId] = liveMetadata;
        }

        if (Object.keys(nextPromotions).length > 0) {
          next[projectPath] = nextPromotions;
          if (Object.keys(nextPromotions).length !== Object.keys(promotions).length) {
            changed = true;
          }
        } else if (Object.keys(promotions).length > 0) {
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [loading, workspaceDraftsByProject, workspaceMetadata]);

  const currentProjectPath = useMemo(() => {
    if (currentProjectPathFromState) return currentProjectPathFromState;
    if (!currentProjectId) return null;

    // Legacy: older deep links stored the full path under ?path=...
    if (projects.has(currentProjectId)) {
      return currentProjectId;
    }

    // Current: project ids are derived from the configured project path.
    for (const projectPath of projects.keys()) {
      if (getProjectRouteId(projectPath) === currentProjectId) {
        return projectPath;
      }
    }

    return null;
  }, [currentProjectId, currentProjectPathFromState, projects]);

  // pendingNewWorkspaceProject is derived from current project in URL/state
  const pendingNewWorkspaceProject = currentProjectPath;
  // pendingNewWorkspaceSectionId is derived from section URL param
  const pendingNewWorkspaceSectionId = pendingSectionId;
  const pendingNewWorkspaceDraftId = pendingNewWorkspaceProject ? pendingDraftId : null;

  // selectedWorkspace is derived from currentWorkspaceId in URL + workspaceMetadata
  const selectedWorkspace = useMemo(() => {
    if (!currentWorkspaceId) return null;
    const metadata = workspaceMetadata.get(currentWorkspaceId);
    if (!metadata) return null;
    return toWorkspaceSelection(metadata);
  }, [currentWorkspaceId, workspaceMetadata]);

  // Keep a ref to the current selectedWorkspace for use in functional updates.
  // Update synchronously so route-driven selection changes are visible before
  // any async creation callbacks decide whether to auto-navigate.
  const selectedWorkspaceRef = useRef(selectedWorkspace);
  selectedWorkspaceRef.current = selectedWorkspace;

  // setSelectedWorkspace navigates to the workspace URL (or clears if null)
  const setSelectedWorkspace = useCallback(
    (update: SetStateAction<WorkspaceSelection | null>) => {
      // Handle functional updates by resolving against the ref (always fresh)
      const current = selectedWorkspaceRef.current;
      const newValue = typeof update === "function" ? update(current) : update;

      // Keep the ref in sync immediately so async handlers (metadata events, etc.) can
      // reliably see the user's latest navigation intent.
      selectedWorkspaceRef.current = newValue;

      if (newValue) {
        navigateToWorkspace(newValue.workspaceId);
        // Persist to localStorage for next session
        updatePersistedState(SELECTED_WORKSPACE_KEY, newValue);
      } else {
        navigateToHome();
        updatePersistedState(SELECTED_WORKSPACE_KEY, null);
      }
    },
    [navigateToWorkspace, navigateToHome]
  );

  /**
   * Clear the workspace selection and navigate to a specific project page
   * instead of home.  Use this when deselecting a workspace where we know
   * which project the user was working in (archive, delete fallback, etc.).
   */
  const clearSelectionToProject = useCallback(
    (projectPath: string) => {
      selectedWorkspaceRef.current = null;
      updatePersistedState(SELECTED_WORKSPACE_KEY, null);
      navigateToProject(projectPath);
    },
    [navigateToProject]
  );

  // Used by async subscription handlers to safely access the most recent metadata map
  // without triggering render-phase state updates.
  const workspaceMetadataRef = useRef(workspaceMetadata);
  useEffect(() => {
    workspaceMetadataRef.current = workspaceMetadata;
  }, [workspaceMetadata]);

  const initialWorkspaceResolvedRef = useRef(false);

  useEffect(() => {
    if (loading) return;
    if (!currentWorkspaceId) return;

    if (currentWorkspaceId === MUX_HELP_CHAT_WORKSPACE_ID) {
      initialWorkspaceResolvedRef.current = true;
      return;
    }

    if (workspaceMetadata.has(currentWorkspaceId)) {
      initialWorkspaceResolvedRef.current = true;
      return;
    }

    // Only auto-redirect on initial restore so we don't fight archive/delete navigation.
    if (initialWorkspaceResolvedRef.current) return;

    const muxChatMetadata = workspaceMetadata.get(MUX_HELP_CHAT_WORKSPACE_ID);
    if (!muxChatMetadata) return;

    // If the last-restored workspace no longer exists, recover to mux-chat instead
    // of leaving the user on a dead-end "Workspace not found" screen.
    initialWorkspaceResolvedRef.current = true;
    setSelectedWorkspace(toWorkspaceSelection(muxChatMetadata));
  }, [currentWorkspaceId, loading, setSelectedWorkspace, workspaceMetadata]);

  const loadWorkspaceMetadata = useCallback(async () => {
    if (!api) return false; // Return false to indicate metadata wasn't loaded
    try {
      const metadataList = await api.workspace.list();
      const metadataMap = new Map<string, FrontendWorkspaceMetadata>();
      for (const metadata of metadataList) {
        // Skip archived workspaces - they should not be tracked by the app
        if (isWorkspaceArchived(metadata.archivedAt, metadata.unarchivedAt)) continue;
        ensureCreatedAt(metadata);
        // Use stable workspace ID as key (not path, which can change)
        seedWorkspaceLocalStorageFromBackend(metadata);
        metadataMap.set(metadata.id, metadata);
      }
      setWorkspaceMetadata(metadataMap);
      return true; // Return true to indicate metadata was loaded
    } catch (error) {
      console.error("Failed to load workspace metadata:", error);
      setWorkspaceMetadata(new Map());
      return true; // Still return true - we tried to load, just got empty result
    }
  }, [setWorkspaceMetadata, api]);

  // Load metadata once on mount (and again when api becomes available)
  useEffect(() => {
    void (async () => {
      const loaded = await loadWorkspaceMetadata();
      if (!loaded) {
        // api not available yet - effect will run again when api connects
        return;
      }
      // After loading metadata (which may trigger migration), reload projects
      // to ensure frontend has the updated config with workspace IDs
      await refreshProjects();
      setLoading(false);
    })();
  }, [loadWorkspaceMetadata, refreshProjects]);

  // URL restoration is now handled by RouterContext which parses the URL on load
  // and provides currentWorkspaceId/currentProjectId that we derive state from.

  // Check for launch project from server (for --add-project flag)
  // This only applies in server mode, runs after metadata loads
  useEffect(() => {
    if (loading || !api) return;

    // Skip if we already have a selected workspace (from localStorage or URL hash)
    if (selectedWorkspace) return;

    // Skip if user is on the settings page — navigating to /settings/:section
    // clears the workspace from the URL, making selectedWorkspace null. Without
    // this guard the effect would auto-select a workspace and navigate away from
    // settings immediately.
    if (currentSettingsSection) return;

    // Skip if user is in the middle of creating a workspace
    if (pendingNewWorkspaceProject) return;

    let cancelled = false;

    const checkLaunchProject = async () => {
      // Only available in server mode (checked via platform/capabilities in future)
      // For now, try the call - it will return null if not applicable
      try {
        const launchProjectPath = await api.server.getLaunchProject(undefined);
        if (cancelled || !launchProjectPath) return;

        // Find first workspace in this project
        const projectWorkspaces = Array.from(workspaceMetadata.values()).filter(
          (meta) => meta.projectPath === launchProjectPath
        );

        if (cancelled || projectWorkspaces.length === 0) return;

        // Select the first workspace in the project.
        // Use functional update to avoid race: user may have clicked a workspace
        // while this async call was in flight.
        const metadata = projectWorkspaces[0];
        setSelectedWorkspace((current) => current ?? toWorkspaceSelection(metadata));
      } catch (error) {
        if (!cancelled) {
          // Ignore errors (e.g. method not found if running against old backend)
          console.debug("Failed to check launch project:", error);
        }
      }
      // If no workspaces exist yet, just leave the project in the sidebar
      // The user will need to create a workspace
    };

    void checkLaunchProject();

    return () => {
      cancelled = true;
    };
  }, [
    api,
    loading,
    selectedWorkspace,
    currentSettingsSection,
    pendingNewWorkspaceProject,
    workspaceMetadata,
    setSelectedWorkspace,
  ]);

  // Subscribe to metadata updates (for create/rename/delete operations)
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();
    const { signal } = controller;

    (async () => {
      try {
        const iterator = await api.workspace.onMetadata(undefined, { signal });

        for await (const event of iterator) {
          if (signal.aborted) break;

          const meta = event.metadata;

          // 1. ALWAYS normalize incoming metadata first - this is the critical data update.
          if (meta !== null) {
            ensureCreatedAt(meta);
            seedWorkspaceLocalStorageFromBackend(meta);
          }

          const isNowArchived =
            meta !== null && isWorkspaceArchived(meta.archivedAt, meta.unarchivedAt);

          // If the currently-selected workspace is being archived, navigate away *before*
          // removing it from the active metadata map. Otherwise we can briefly render the
          // welcome screen while still on `/workspace/:id`.
          //
          // Prefer the next workspace in sidebar DOM order (like Ctrl+J) so the user
          // stays in flow; fall back to the project page when no siblings remain.
          if (meta !== null && isNowArchived) {
            const currentSelection = selectedWorkspaceRef.current;
            if (currentSelection?.workspaceId === event.workspaceId) {
              const nextId = findAdjacentWorkspaceId(event.workspaceId);
              const nextMeta = nextId ? workspaceMetadataRef.current.get(nextId) : null;

              if (nextMeta) {
                setSelectedWorkspace(toWorkspaceSelection(nextMeta));
              } else {
                clearSelectionToProject(meta.projectPath);
              }
            }
          }

          // Capture deleted workspace info before removing from map (needed for navigation)
          const deletedMeta =
            meta === null ? workspaceMetadataRef.current.get(event.workspaceId) : null;

          setWorkspaceMetadata((prev) => {
            const updated = new Map(prev);
            const isNewWorkspace = !prev.has(event.workspaceId) && meta !== null;
            const existingMeta = prev.get(event.workspaceId);
            const wasInitializing = existingMeta?.isInitializing === true;
            const isNowReady = meta !== null && meta.isInitializing !== true;

            if (meta === null || isNowArchived) {
              // Remove deleted or newly-archived workspaces from active map
              updated.delete(event.workspaceId);
            } else {
              // Only add/update non-archived workspaces (including unarchived ones)
              updated.set(event.workspaceId, meta);
            }

            // Reload projects when:
            // 1. New workspace appears (e.g., from fork)
            // 2. Workspace transitions from initializing to ready (init completed)
            if (isNewWorkspace || (wasInitializing && isNowReady)) {
              void refreshProjects();
            }

            return updated;
          });

          // 2. THEN handle side effects (cleanup, navigation) - these can't break data updates
          if (meta === null) {
            deleteWorkspaceStorage(event.workspaceId);

            // Navigate away only if the deleted workspace was selected
            const currentSelection = selectedWorkspaceRef.current;
            if (currentSelection?.workspaceId !== event.workspaceId) continue;

            // Try parent workspace first
            const parentWorkspaceId = deletedMeta?.parentWorkspaceId;
            const parentMeta = parentWorkspaceId
              ? workspaceMetadataRef.current.get(parentWorkspaceId)
              : null;

            if (parentMeta) {
              setSelectedWorkspace({
                workspaceId: parentMeta.id,
                projectPath: parentMeta.projectPath,
                projectName: parentMeta.projectName,
                namedWorkspacePath: parentMeta.namedWorkspacePath,
              });
              continue;
            }

            // Try sibling workspace in same project
            const projectPath = deletedMeta?.projectPath;
            const fallbackMeta =
              (projectPath
                ? Array.from(workspaceMetadataRef.current.values()).find(
                    (meta) => meta.projectPath === projectPath && meta.id !== event.workspaceId
                  )
                : null) ??
              Array.from(workspaceMetadataRef.current.values()).find(
                (meta) => meta.id !== event.workspaceId
              );

            if (fallbackMeta) {
              setSelectedWorkspace(toWorkspaceSelection(fallbackMeta));
            } else if (projectPath) {
              clearSelectionToProject(projectPath);
            } else {
              setSelectedWorkspace(null);
            }
          }
        }
      } catch (err) {
        if (!signal.aborted && !isAbortError(err)) {
          console.error("Failed to subscribe to metadata:", err);
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [clearSelectionToProject, refreshProjects, setSelectedWorkspace, setWorkspaceMetadata, api]);

  const createWorkspace = useCallback(
    async (
      projectPath: string,
      branchName: string,
      trunkBranch: string,
      runtimeConfig?: RuntimeConfig
    ) => {
      if (!api) throw new Error("API not connected");
      console.assert(
        typeof trunkBranch === "string" && trunkBranch.trim().length > 0,
        "Expected trunk branch to be provided when creating a workspace"
      );
      const result = await api.workspace.create({
        projectPath,
        branchName,
        trunkBranch,
        runtimeConfig,
      });
      if (result.success) {
        // Backend has already updated the config - reload projects to get updated state
        await refreshProjects();

        // Update metadata immediately to avoid race condition with validation effect
        ensureCreatedAt(result.metadata);
        seedWorkspaceLocalStorageFromBackend(result.metadata);
        setWorkspaceMetadata((prev) => {
          const updated = new Map(prev);
          updated.set(result.metadata.id, result.metadata);
          return updated;
        });

        // Return the new workspace selection
        return {
          projectPath,
          projectName: result.metadata.projectName,
          namedWorkspacePath: result.metadata.namedWorkspacePath,
          workspaceId: result.metadata.id,
        };
      } else {
        throw new Error(result.error);
      }
    },
    [api, refreshProjects, setWorkspaceMetadata]
  );

  const removeWorkspace = useCallback(
    async (
      workspaceId: string,
      options?: { force?: boolean }
    ): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };

      // Capture state before the async operation.
      // We check currentWorkspaceId (from URL) rather than selectedWorkspace
      // because it's the source of truth for what's actually selected.
      const wasSelected = currentWorkspaceId === workspaceId;
      const projectPath = selectedWorkspace?.projectPath;

      try {
        const result = await api.workspace.remove({ workspaceId, options });
        if (result.success) {
          // Clean up workspace-specific localStorage keys
          deleteWorkspaceStorage(workspaceId);

          // Optimistically remove from the local metadata map so the sidebar updates immediately.
          // Relying on the metadata subscription can leave the item visible until the next refresh.
          setWorkspaceMetadata((prev) => {
            const updated = new Map(prev);
            updated.delete(workspaceId);
            return updated;
          });

          // Backend has already updated the config - reload projects to get updated state
          await refreshProjects();

          // Workspace metadata subscription handles the removal automatically.
          // No need to refetch all metadata - this avoids expensive post-compaction
          // state checks for all workspaces.

          // If the removed workspace was selected (URL was on this workspace),
          // navigate to its project page instead of going home
          if (wasSelected && projectPath) {
            navigateToProject(projectPath);
          }
          // If not selected, don't navigate at all - stay where we are
          return { success: true };
        } else {
          console.error("Failed to remove workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to remove workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [
      currentWorkspaceId,
      navigateToProject,
      refreshProjects,
      selectedWorkspace,
      api,
      setWorkspaceMetadata,
    ]
  );

  /**
   * Update workspace title (formerly "rename").
   * Unlike the old rename which changed the git branch/directory name,
   * this only updates the display title and can be called during streaming.
   *
   * Note: This is simpler than the old rename because the workspace ID doesn't change.
   * We just reload metadata after the update - no need to update selectedWorkspace
   * since the ID stays the same and the metadata map refresh handles the title update.
   */
  const updateWorkspaceTitle = useCallback(
    async (
      workspaceId: string,
      newTitle: string
    ): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.updateTitle({ workspaceId, title: newTitle });
        if (result.success) {
          // Workspace metadata subscription handles the title update automatically.
          // No need to refetch all metadata - this avoids expensive post-compaction
          // state checks for all workspaces (which can be slow for SSH workspaces).
          return { success: true };
        } else {
          console.error("Failed to update workspace title:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to update workspace title:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  const archiveWorkspace = useCallback(
    async (workspaceId: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };

      try {
        const result = await api.workspace.archive({ workspaceId });
        if (result.success) {
          // Workspace list + navigation are driven by the workspace metadata subscription.
          return { success: true };
        }

        console.error("Failed to archive workspace:", result.error);
        return { success: false, error: result.error };
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to archive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  const unarchiveWorkspace = useCallback(
    async (workspaceId: string): Promise<{ success: boolean; error?: string }> => {
      if (!api) return { success: false, error: "API not connected" };
      try {
        const result = await api.workspace.unarchive({ workspaceId });
        if (result.success) {
          // Workspace metadata subscription handles the state update automatically.
          return { success: true };
        } else {
          console.error("Failed to unarchive workspace:", result.error);
          return { success: false, error: result.error };
        }
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        console.error("Failed to unarchive workspace:", errorMessage);
        return { success: false, error: errorMessage };
      }
    },
    [api]
  );

  const refreshWorkspaceMetadata = useCallback(async () => {
    await loadWorkspaceMetadata();
  }, [loadWorkspaceMetadata]);

  const getWorkspaceInfo = useCallback(
    async (workspaceId: string) => {
      if (!api) return null;
      const metadata = await api.workspace.getInfo({ workspaceId });
      if (metadata) {
        ensureCreatedAt(metadata);
        seedWorkspaceLocalStorageFromBackend(metadata);
      }
      return metadata;
    },
    [api]
  );

  const promoteWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string, metadata: FrontendWorkspaceMetadata) => {
      if (projectPath.trim().length === 0) return;
      if (draftId.trim().length === 0) return;

      setWorkspaceDraftPromotionsByProject((prev) => {
        const currentProject = prev[projectPath] ?? {};
        const existing = currentProject[draftId];
        if (existing?.id === metadata.id) {
          return prev;
        }

        return {
          ...prev,
          [projectPath]: {
            ...currentProject,
            [draftId]: metadata,
          },
        };
      });
    },
    []
  );
  const beginWorkspaceCreation = useCallback(
    (projectPath: string, sectionId?: string) => {
      if (workspaceMetadata.get(MUX_HELP_CHAT_WORKSPACE_ID)?.projectPath === projectPath) {
        navigateToWorkspace(MUX_HELP_CHAT_WORKSPACE_ID);
        return;
      }

      navigateToProject(projectPath, sectionId);
    },
    [navigateToProject, navigateToWorkspace, workspaceMetadata]
  );
  // Persist section selection + URL updates so draft section switches stick across navigation.
  const updateWorkspaceDraftSection = useCallback(
    (projectPath: string, draftId: string, sectionId: string | null) => {
      if (projectPath.trim().length === 0) return;
      if (draftId.trim().length === 0) return;

      const normalizedSectionId =
        typeof sectionId === "string" && sectionId.trim().length > 0 ? sectionId : null;

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];
        if (existing.length === 0) {
          return prev;
        }

        let didUpdate = false;
        const nextDrafts = existing.map((draft) => {
          if (draft.draftId !== draftId) {
            return draft;
          }
          if (draft.sectionId === normalizedSectionId) {
            return draft;
          }
          didUpdate = true;
          return {
            ...draft,
            sectionId: normalizedSectionId,
          };
        });

        if (!didUpdate) {
          return prev;
        }

        return {
          ...current,
          [projectPath]: nextDrafts,
        };
      });

      navigateToProject(projectPath, normalizedSectionId ?? undefined, draftId);
    },
    [navigateToProject, setWorkspaceDraftsByProjectState]
  );

  const createWorkspaceDraft = useCallback(
    (projectPath: string, sectionId?: string) => {
      // Read directly from localStorage to get the freshest value, avoiding stale closure issues.
      // The React state (workspaceDraftsByProject) may be out of date if this is called rapidly.
      const freshDrafts = normalizeWorkspaceDraftsByProject(
        readPersistedState<WorkspaceDraftsByProject>(WORKSPACE_DRAFTS_BY_PROJECT_KEY, {})
      );
      const existingDrafts = freshDrafts[projectPath] ?? [];

      // If there's an existing empty draft (optionally in the same section), reuse it
      // instead of creating yet another empty draft.
      const existingEmptyDraftId = findExistingEmptyDraft(existingDrafts, projectPath, sectionId);
      if (existingEmptyDraftId) {
        navigateToProject(projectPath, sectionId, existingEmptyDraftId);
        return;
      }

      const draftId = createWorkspaceDraftId();
      const createdAt = Date.now();
      const draft: WorkspaceDraft = {
        draftId,
        sectionId: sectionId ?? null,
        createdAt,
      };

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];

        // One-time migration: if the user has an old per-project pending draft, move it
        // into the first draft scope so it stays accessible.
        if (existing.length === 0) {
          const pendingScopeId = getPendingScopeId(projectPath);
          const legacyInput = readPersistedState<string>(getInputKey(pendingScopeId), "");
          const legacyAttachments = readPersistedState<unknown>(
            getInputAttachmentsKey(pendingScopeId),
            []
          );
          const hasLegacyAttachments =
            Array.isArray(legacyAttachments) && legacyAttachments.length > 0;
          if (legacyInput.trim().length > 0 || hasLegacyAttachments) {
            migrateWorkspaceStorage(pendingScopeId, getDraftScopeId(projectPath, draftId));
          }
        }

        return {
          ...current,
          [projectPath]: [...existing, draft],
        };
      });

      navigateToProject(projectPath, sectionId, draftId);
    },
    [navigateToProject, setWorkspaceDraftsByProjectState]
  );

  const openWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string, sectionId?: string | null) => {
      const normalizedSectionId =
        typeof sectionId === "string" && sectionId.trim().length > 0 ? sectionId : undefined;
      navigateToProject(projectPath, normalizedSectionId, draftId);
    },
    [navigateToProject]
  );

  const deleteWorkspaceDraft = useCallback(
    (projectPath: string, draftId: string) => {
      setWorkspaceDraftPromotionsByProject((prev) => {
        const currentProject = prev[projectPath];
        if (!currentProject || !(draftId in currentProject)) {
          return prev;
        }

        const nextProject = { ...currentProject };
        delete nextProject[draftId];

        const next: WorkspaceDraftPromotionsByProject = { ...prev };
        if (Object.keys(nextProject).length === 0) {
          delete next[projectPath];
        } else {
          next[projectPath] = nextProject;
        }
        return next;
      });

      deleteWorkspaceStorage(getDraftScopeId(projectPath, draftId));

      setWorkspaceDraftsByProjectState((prev) => {
        const current = normalizeWorkspaceDraftsByProject(prev);
        const existing = current[projectPath] ?? [];
        const nextDrafts = existing.filter((draft) => draft.draftId !== draftId);

        const next: WorkspaceDraftsByProject = { ...current };
        if (nextDrafts.length === 0) {
          delete next[projectPath];
        } else {
          next[projectPath] = nextDrafts;
        }
        return next;
      });
    },
    [setWorkspaceDraftPromotionsByProject, setWorkspaceDraftsByProjectState]
  );

  // Split into two context values so metadata-Map churn doesn't re-render
  // components that only need actions/selection/drafts.
  const metadataValue = useMemo<WorkspaceMetadataContextValue>(
    () => ({ workspaceMetadata, loading }),
    [workspaceMetadata, loading]
  );

  const actionsValue = useMemo(
    () => ({
      createWorkspace,
      removeWorkspace,
      updateWorkspaceTitle,
      archiveWorkspace,
      unarchiveWorkspace,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      pendingNewWorkspaceSectionId,
      pendingNewWorkspaceDraftId,
      beginWorkspaceCreation,
      workspaceDraftsByProject,
      workspaceDraftPromotionsByProject,
      promoteWorkspaceDraft,
      createWorkspaceDraft,
      updateWorkspaceDraftSection,
      openWorkspaceDraft,
      deleteWorkspaceDraft,
      getWorkspaceInfo,
    }),
    [
      createWorkspace,
      removeWorkspace,
      updateWorkspaceTitle,
      archiveWorkspace,
      unarchiveWorkspace,
      refreshWorkspaceMetadata,
      setWorkspaceMetadata,
      selectedWorkspace,
      setSelectedWorkspace,
      pendingNewWorkspaceProject,
      pendingNewWorkspaceSectionId,
      pendingNewWorkspaceDraftId,
      beginWorkspaceCreation,
      workspaceDraftsByProject,
      workspaceDraftPromotionsByProject,
      promoteWorkspaceDraft,
      createWorkspaceDraft,
      updateWorkspaceDraftSection,
      openWorkspaceDraft,
      deleteWorkspaceDraft,
      getWorkspaceInfo,
    ]
  );

  return (
    <WorkspaceMetadataContext.Provider value={metadataValue}>
      <WorkspaceActionsContext.Provider value={actionsValue}>
        {props.children}
      </WorkspaceActionsContext.Provider>
    </WorkspaceMetadataContext.Provider>
  );
}

/**
 * Subscribe to workspace metadata only. Use this in components that need the
 * metadata Map but don't need actions/selection (avoids re-rendering on
 * selection or draft changes).
 */
export function useWorkspaceMetadata(): WorkspaceMetadataContextValue {
  const context = useContext(WorkspaceMetadataContext);
  if (!context) {
    throw new Error("useWorkspaceMetadata must be used within WorkspaceProvider");
  }
  return context;
}

/**
 * Subscribe to workspace actions/selection/drafts only. This context value is
 * stable across metadata-Map changes, so sidebar-like components that don't
 * need the full Map can avoid re-renders.
 */
export function useWorkspaceActions(): Omit<WorkspaceContext, "workspaceMetadata" | "loading"> {
  const context = useContext(WorkspaceActionsContext);
  if (!context) {
    throw new Error("useWorkspaceActions must be used within WorkspaceProvider");
  }
  return context;
}

/**
 * Backward-compatible hook that merges both contexts into the full
 * WorkspaceContext shape. Subscribes to BOTH metadata and actions contexts,
 * so it re-renders on any change. Prefer the narrower hooks above when possible.
 */
export function useWorkspaceContext(): WorkspaceContext {
  const metadata = useWorkspaceMetadata();
  const actions = useWorkspaceActions();
  return useMemo(() => ({ ...metadata, ...actions }), [metadata, actions]);
}

/**
 * Optional version of useWorkspaceContext.
 *
 * This is useful for environments that render message/tool components without the full
 * workspace shell (e.g. VS Code webviews).
 */
export function useOptionalWorkspaceContext(): WorkspaceContext | null {
  const metadataCtx = useContext(WorkspaceMetadataContext);
  const actionsCtx = useContext(WorkspaceActionsContext);
  if (!metadataCtx || !actionsCtx) return null;
  // eslint-disable-next-line react-hooks/rules-of-hooks -- both arms are stable across renders
  return useMemo(() => ({ ...metadataCtx, ...actionsCtx }), [metadataCtx, actionsCtx]);
}
