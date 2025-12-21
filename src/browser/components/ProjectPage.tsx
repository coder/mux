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
          {/* Scrollable flex column: chat centered, archived at bottom */}
          <div className="flex h-full flex-1 flex-col items-center overflow-y-auto p-4">
            {/* Spacer pushes chat toward center */}
            <div className="flex-1" />
            {/* Chat input card */}
            <ChatInput
              variant="creation"
              projectPath={projectPath}
              projectName={projectName}
              onProviderConfig={onProviderConfig}
              onReady={handleChatReady}
              onWorkspaceCreated={onWorkspaceCreated}
            />
            {/* Spacer between chat and archived */}
            <div className="flex-1" />
            {/* Archived workspaces at bottom */}
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
        </ThinkingProvider>
      </ProviderOptionsProvider>
    </ModeProvider>
  );
};
