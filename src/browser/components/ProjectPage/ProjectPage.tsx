import React, { useRef, useCallback, useState, useEffect } from "react";
import { Menu } from "lucide-react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { cn } from "@/common/lib/utils";
import { AgentProvider } from "@/browser/contexts/AgentContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import {
  ChatInput,
  CREATION_CHAT_INPUT_SECTION_FRAME_CLASS,
} from "@/browser/features/ChatInput/index";
import type { ChatInputAPI, WorkspaceCreatedOptions } from "@/browser/features/ChatInput/types";
import { ProjectMCPOverview } from "../ProjectMCPOverview/ProjectMCPOverview";
import { ArchivedWorkspaces } from "../ArchivedWorkspaces/ArchivedWorkspaces";
import { useAPI } from "@/browser/contexts/API";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { GitInitBanner } from "../GitInitBanner/GitInitBanner";
import {
  ConfiguredProvidersBar,
  ConfiguredProvidersBarSkeleton,
} from "../ConfiguredProvidersBar/ConfiguredProvidersBar";
import { ConfigureProvidersPrompt } from "../ConfigureProvidersPrompt/ConfigureProvidersPrompt";
import { Skeleton } from "../Skeleton/Skeleton";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import type { ProvidersConfigMap } from "@/common/orpc/types";
import {
  AgentsInitBanner,
  AgentsInitBannerPlaceholder,
} from "../AgentsInitBanner/AgentsInitBanner";
import {
  usePersistedState,
  updatePersistedState,
  readPersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getAgentIdKey,
  getAgentsInitNudgeKey,
  getArchivedWorkspacesKey,
  HAS_CONFIGURED_PROVIDER_CACHE_KEY,
  getDraftScopeId,
  getInputKey,
  getPendingScopeId,
  getProjectScopeId,
} from "@/common/constants/storage";
import { Button } from "@/browser/components/Button/Button";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";

interface ProjectPageProps {
  projectPath: string;
  projectName: string;
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
  /** Sub-project path for parent-owned draft creation. */
  pendingSubProjectPath?: string | null;
  /** Draft ID for UI-only workspace creation drafts (from URL) */
  pendingDraftId?: string | null;
  onWorkspaceCreated: (
    metadata: FrontendWorkspaceMetadata,
    options?: WorkspaceCreatedOptions
  ) => void;
}

/** Compare archived workspace lists by ID set (order doesn't matter for equality) */
function archivedListsEqual(
  prev: FrontendWorkspaceMetadata[],
  next: FrontendWorkspaceMetadata[]
): boolean {
  if (prev.length !== next.length) return false;
  const prevIds = new Set(prev.map((w) => w.id));
  return next.every((w) => prevIds.has(w.id));
}

/** Check if any provider is configured (uses backend-computed isConfigured) */
function hasConfiguredProvider(config: ProvidersConfigMap | null): boolean {
  if (!config) return false;
  return Object.values(config).some((provider) => provider?.isConfigured);
}

const PROJECT_CREATION_PROVIDER_GATE_CLASS = "flex min-h-[30rem] flex-col justify-end gap-4";

function CreationChatInputSkeleton() {
  return (
    <div
      // Mirrors the creation ChatInput frame while provider availability is still unknown.
      // Showing an actual composer before we know providers exist causes a no-provider
      // hydration swap to look like a layout flash.
      aria-hidden="true"
      className={CREATION_CHAT_INPUT_SECTION_FRAME_CLASS}
      data-component="ChatInputSectionSkeleton"
    >
      <div className="flex flex-col gap-4">
        <Skeleton className="h-7 w-56" />
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-7 w-full" />
          </div>
          <div className="flex min-w-40 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-full" />
          </div>
        </div>
        <Skeleton className="h-28 w-full" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-8 w-8 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * Project page shown when a project is selected but no workspace is active.
 * Combines workspace creation with archived workspaces view.
 */
export const ProjectPage: React.FC<ProjectPageProps> = ({
  projectPath,
  projectName,
  leftSidebarCollapsed,
  onToggleLeftSidebarCollapsed,
  pendingSubProjectPath,
  pendingDraftId,
  onWorkspaceCreated,
}) => {
  const { api } = useAPI();
  const chatInputRef = useRef<ChatInputAPI | null>(null);
  const pendingAgentsInitSendRef = useRef(false);
  // Initialize from localStorage cache to avoid flash when archived workspaces appear
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<FrontendWorkspaceMetadata[]>(() =>
    readPersistedState<FrontendWorkspaceMetadata[]>(getArchivedWorkspacesKey(projectPath), [])
  );
  const [showAgentsInitNudge, setShowAgentsInitNudge] = usePersistedState<boolean>(
    getAgentsInitNudgeKey(projectPath),
    false,
    { listener: true }
  );
  const [cachedHasProviders] = useState<boolean | null>(() =>
    readPersistedState<boolean | null>(HAS_CONFIGURED_PROVIDER_CACHE_KEY, null)
  );
  const { config: providersConfig, loading: providersLoading } = useProvidersConfig();
  const hasProviders = hasConfiguredProvider(providersConfig);
  const effectiveHasProviders = providersLoading ? cachedHasProviders : hasProviders;
  const isProviderAvailabilityUnknown = effectiveHasProviders === null;
  const shouldShowProviderPrompt = effectiveHasProviders === false;
  const shouldRenderCreationChat = effectiveHasProviders === true;
  const shouldReserveAgentsInitBanner =
    showAgentsInitNudge && (providersLoading || shouldRenderCreationChat);
  const shouldShowAgentsInitBanner =
    !providersLoading && shouldRenderCreationChat && showAgentsInitNudge;

  // Git repository state for the banner
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [hasBranches, setHasBranches] = useState(true); // Assume git repo until proven otherwise
  const [branchRefreshKey, setBranchRefreshKey] = useState(0);

  // Load branches to determine if this is a git repository.
  // Uses local cancelled flag (not ref) to handle StrictMode double-renders correctly.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    (async () => {
      // Don't reset branchesLoaded - it starts false, becomes true after first load.
      // This keeps banner mounted during refetch so success message stays visible.
      try {
        const result = await api.projects.listBranches({ projectPath });
        if (cancelled) return;
        setHasBranches(result.branches.length > 0);
      } catch (err) {
        console.error("Failed to load branches:", err);
        if (cancelled) return;
        setHasBranches(true); // On error, don't show banner
      } finally {
        if (!cancelled) {
          setBranchesLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, projectPath, branchRefreshKey]);

  const isNonGitRepo = branchesLoaded && !hasBranches;

  // Trigger branch refetch after git init to verify it worked
  const handleGitInitSuccess = useCallback(() => {
    setBranchRefreshKey((k) => k + 1);
  }, []);

  // Track archived workspaces in a ref; only update state when the list actually changes
  const archivedMapRef = useRef<Map<string, FrontendWorkspaceMetadata>>(new Map());

  const syncArchivedState = useCallback(() => {
    const next = Array.from(archivedMapRef.current.values());
    setArchivedWorkspaces((prev) => {
      if (archivedListsEqual(prev, next)) return prev;
      // Persist to localStorage for optimistic cache on next load
      updatePersistedState(getArchivedWorkspacesKey(projectPath), next);
      return next;
    });
  }, [projectPath]);

  // Fetch archived workspaces for this project on mount
  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    const loadArchived = async () => {
      try {
        const allArchived = await api.workspace.list({ archived: true });
        if (cancelled) return;
        const projectArchived = allArchived.filter((w) => w.projectPath === projectPath);
        archivedMapRef.current = new Map(projectArchived.map((w) => [w.id, w]));
        syncArchivedState();
      } catch (error) {
        console.error("Failed to load archived workspaces:", error);
      }
    };

    void loadArchived();
    return () => {
      cancelled = true;
    };
  }, [api, projectPath, syncArchivedState]);

  // Subscribe to metadata events to reactively update archived list
  useEffect(() => {
    if (!api) return;
    const controller = new AbortController();

    (async () => {
      try {
        const iterator = await api.workspace.onMetadata(undefined, { signal: controller.signal });
        for await (const event of iterator) {
          if (controller.signal.aborted) break;

          const meta = event.metadata;
          // Only care about workspaces in this project
          if (meta && meta.projectPath !== projectPath) continue;
          // For deletions, check if it was in our map (i.e., was in this project)
          if (!meta && !archivedMapRef.current.has(event.workspaceId)) continue;

          const isArchived = meta && isWorkspaceArchived(meta.archivedAt, meta.unarchivedAt);

          if (isArchived) {
            archivedMapRef.current.set(meta.id, meta);
          } else {
            archivedMapRef.current.delete(event.workspaceId);
          }

          syncArchivedState();
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("Failed to subscribe to metadata for archived workspaces:", err);
        }
      }
    })();

    return () => controller.abort();
  }, [api, projectPath, syncArchivedState]);

  const didAutoFocusRef = useRef(false);

  const handleDismissAgentsInit = useCallback(() => {
    setShowAgentsInitNudge(false);
  }, [setShowAgentsInitNudge]);

  const handleRunAgentsInit = useCallback(() => {
    // Switch project-scope mode to exec.
    updatePersistedState(getAgentIdKey(getProjectScopeId(projectPath)), "exec");

    // Run the /init skill and start the creation chat.
    if (chatInputRef.current) {
      chatInputRef.current.restoreText("/init");
      requestAnimationFrame(() => {
        void chatInputRef.current?.send();
      });
    } else {
      pendingAgentsInitSendRef.current = true;
      const pendingScopeId =
        typeof pendingDraftId === "string" && pendingDraftId.trim().length > 0
          ? getDraftScopeId(projectPath, pendingDraftId)
          : getPendingScopeId(projectPath);
      updatePersistedState(getInputKey(pendingScopeId), "/init");
    }

    setShowAgentsInitNudge(false);
  }, [projectPath, pendingDraftId, setShowAgentsInitNudge]);

  const handleChatReady = useCallback((api: ChatInputAPI) => {
    chatInputRef.current = api;

    if (pendingAgentsInitSendRef.current) {
      pendingAgentsInitSendRef.current = false;
      didAutoFocusRef.current = true;
      api.restoreText("/init");
      requestAnimationFrame(() => {
        void api.send();
      });
      return;
    }

    // Auto-focus the prompt once when entering the creation screen.
    // Defensive: avoid re-focusing on unrelated re-renders (e.g. workspace list updates),
    // which can move the user's caret.
    if (didAutoFocusRef.current) {
      return;
    }
    didAutoFocusRef.current = true;
    api.focus();
  }, []);

  return (
    <AgentProvider projectPath={projectPath}>
      <ThinkingProvider projectPath={projectPath}>
        {/* Flex container to fill parent space */}
        <div className="bg-surface-primary relative flex flex-1 flex-col overflow-hidden">
          {/* Draggable header bar - matches WorkspaceMenuBar for consistency */}
          <div
            className={cn(
              "bg-sidebar border-border-light mobile-sticky-header flex shrink-0 items-center border-b px-2 [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
              isDesktopMode() ? "h-10 titlebar-drag" : "h-8"
            )}
          >
            {leftSidebarCollapsed && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleLeftSidebarCollapsed}
                title="Open sidebar"
                aria-label="Open sidebar menu"
                className={cn(
                  "hidden mobile-menu-btn h-6 w-6 shrink-0 text-muted hover:text-foreground",
                  isDesktopMode() && "titlebar-no-drag"
                )}
              >
                <Menu className="h-4 w-4" />
              </Button>
            )}
          </div>
          {/* Scrollable content area */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Main content - vertically centered with reduced gaps */}
            <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-6">
              <div className="flex w-full max-w-3xl flex-col gap-4">
                {/* Git init banner - shown above ChatInput when not a git repo */}
                {isNonGitRepo && (
                  <GitInitBanner projectPath={projectPath} onSuccess={handleGitInitSuccess} />
                )}
                <div
                  // Keep the provider-dependent creation branch in a stable frame. The
                  // budget covers the agents nudge + provider bar + initial composer;
                  // shorter states bottom-align inside it instead of recentering the page.
                  className={PROJECT_CREATION_PROVIDER_GATE_CLASS}
                  data-component="ProjectCreationProviderGate"
                >
                  {/* Show configure prompt when no providers, otherwise show ChatInput. */}
                  {shouldShowProviderPrompt ? (
                    <ConfigureProvidersPrompt />
                  ) : (
                    <>
                      {shouldReserveAgentsInitBanner &&
                        (shouldShowAgentsInitBanner ? (
                          <AgentsInitBanner
                            onRunInit={handleRunAgentsInit}
                            onDismiss={handleDismissAgentsInit}
                          />
                        ) : (
                          <AgentsInitBannerPlaceholder />
                        ))}
                      {/* Configured providers bar - compact icon carousel */}
                      {providersLoading ? (
                        <ConfiguredProvidersBarSkeleton />
                      ) : (
                        hasProviders &&
                        providersConfig && (
                          <ConfiguredProvidersBar providersConfig={providersConfig} />
                        )
                      )}
                      {/* ChatInput for workspace creation. */}
                      {isProviderAvailabilityUnknown ? (
                        <CreationChatInputSkeleton />
                      ) : shouldRenderCreationChat ? (
                        <ChatInput
                          // Key by project + draft so project navigation and draft switches both remount
                          // creation-local state (including any in-flight creation overlays).
                          key={`${projectPath}:${pendingDraftId ?? "__pending__"}`}
                          variant="creation"
                          projectPath={projectPath}
                          projectName={projectName}
                          pendingSubProjectPath={pendingSubProjectPath}
                          pendingDraftId={pendingDraftId}
                          onReady={handleChatReady}
                          onWorkspaceCreated={onWorkspaceCreated}
                        />
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* MCP servers: overview between creation and archived workspaces */}
            <div className="flex justify-center px-4 pb-4">
              <div className="w-full max-w-3xl">
                <ProjectMCPOverview projectPath={projectPath} />
              </div>
            </div>

            {/* Archived workspaces: separate section below centered area */}
            {archivedWorkspaces.length > 0 && (
              <div className="flex justify-center px-4 pb-4">
                <div className="w-full max-w-3xl">
                  <ArchivedWorkspaces
                    projectPath={projectPath}
                    projectName={projectName}
                    workspaces={archivedWorkspaces}
                    onWorkspacesChanged={() => {
                      // Refresh archived list after unarchive/delete
                      if (!api) return;
                      void api.workspace.list({ archived: true }).then((all) => {
                        setArchivedWorkspaces(all.filter((w) => w.projectPath === projectPath));
                      });
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </ThinkingProvider>
    </AgentProvider>
  );
};
