import React, { useRef, useCallback, useState, useEffect } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { ModeProvider } from "@/browser/contexts/ModeContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { ChatInput } from "./ChatInput/index";
import type { ChatInputAPI } from "./ChatInput/types";
import { ArchivedWorkspaces } from "./ArchivedWorkspaces";
import { useAPI } from "@/browser/contexts/API";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { GitInitBanner } from "./GitInitBanner";

interface ProjectPageProps {
  projectPath: string;
  projectName: string;
  onProviderConfig: (provider: string, keyPath: string[], value: string) => Promise<void>;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
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

/**
 * Project page shown when a project is selected but no workspace is active.
 * Combines workspace creation with archived workspaces view.
 */
export const ProjectPage: React.FC<ProjectPageProps> = ({
  projectPath,
  projectName,
  onProviderConfig,
  onWorkspaceCreated,
}) => {
  const { api } = useAPI();
  const chatInputRef = useRef<ChatInputAPI | null>(null);
  const [archivedWorkspaces, setArchivedWorkspaces] = useState<FrontendWorkspaceMetadata[]>([]);

  // Git repository state for the banner
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [hasBranches, setHasBranches] = useState(true); // Assume git repo until proven otherwise

  // Load branches to determine if this is a git repository
  const loadBranches = useCallback(async () => {
    if (!api) return;
    setBranchesLoaded(false);
    try {
      const result = await api.projects.listBranches({ projectPath });
      setHasBranches(result.branches.length > 0);
    } catch (err) {
      console.error("Failed to load branches:", err);
      setHasBranches(true); // On error, don't show banner
    } finally {
      setBranchesLoaded(true);
    }
  }, [api, projectPath]);

  // Load branches on mount
  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const isNonGitRepo = branchesLoaded && !hasBranches;

  // Track archived workspaces in a ref; only update state when the list actually changes
  const archivedMapRef = useRef<Map<string, FrontendWorkspaceMetadata>>(new Map());

  const syncArchivedState = useCallback(() => {
    const next = Array.from(archivedMapRef.current.values());
    setArchivedWorkspaces((prev) => (archivedListsEqual(prev, next) ? prev : next));
  }, []);

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
  const handleChatReady = useCallback((api: ChatInputAPI) => {
    chatInputRef.current = api;

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
    <ModeProvider projectPath={projectPath}>
      <ProviderOptionsProvider>
        <ThinkingProvider projectPath={projectPath}>
          <ConnectionStatusIndicator />
          {/* Scrollable content area */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/* Main content - vertically centered with reduced gaps */}
            <div className="flex min-h-[50vh] flex-col items-center justify-center px-4 py-6">
              <div className="flex w-full max-w-3xl flex-col gap-4">
                {/* Git init banner - shown above ChatInput when not a git repo */}
                {isNonGitRepo && (
                  <GitInitBanner projectPath={projectPath} onSuccess={loadBranches} />
                )}
                {/* ChatInput for workspace creation */}
                <ChatInput
                  variant="creation"
                  projectPath={projectPath}
                  projectName={projectName}
                  onProviderConfig={onProviderConfig}
                  onReady={handleChatReady}
                  onWorkspaceCreated={onWorkspaceCreated}
                />
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
        </ThinkingProvider>
      </ProviderOptionsProvider>
    </ModeProvider>
  );
};
