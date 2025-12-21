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

interface ProjectPageProps {
  projectPath: string;
  projectName: string;
  onProviderConfig: (provider: string, keyPath: string[], value: string) => Promise<void>;
  onWorkspaceCreated: (metadata: FrontendWorkspaceMetadata) => void;
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

  // Fetch archived workspaces for this project
  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    const loadArchived = async () => {
      try {
        const allArchived = await api.workspace.list({ archived: true });
        if (cancelled) return;
        // Filter to just this project's archived workspaces
        const projectArchived = allArchived.filter((w) => w.projectPath === projectPath);
        setArchivedWorkspaces(projectArchived);
      } catch (error) {
        console.error("Failed to load archived workspaces:", error);
      }
    };

    void loadArchived();
    return () => {
      cancelled = true;
    };
  }, [api, projectPath]);

  const handleChatReady = useCallback((api: ChatInputAPI) => {
    chatInputRef.current = api;
    api.focus();
  }, []);

  return (
    <ModeProvider projectPath={projectPath}>
      <ProviderOptionsProvider>
        <ThinkingProvider projectPath={projectPath}>
          <ConnectionStatusIndicator />
          {/* Scrollable content area */}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {/*
              IMPORTANT: Keep vertical centering off the scroll container.
              When a flex scroll container uses justify-center and content becomes tall,
              browsers can end up with a scroll origin that makes the top feel "cut off".
            */}
            <div className="flex min-h-full flex-col items-center justify-center gap-6 p-4">
              {/* Chat input card */}
              <ChatInput
                variant="creation"
                projectPath={projectPath}
                projectName={projectName}
                onProviderConfig={onProviderConfig}
                onReady={handleChatReady}
                onWorkspaceCreated={onWorkspaceCreated}
              />
              {/* Archived workspaces below chat */}
              {archivedWorkspaces.length > 0 && (
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
              )}
            </div>
          </div>
        </ThinkingProvider>
      </ProviderOptionsProvider>
    </ModeProvider>
  );
};
