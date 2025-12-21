import React, { useRef, useCallback } from "react";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { ModeProvider } from "@/browser/contexts/ModeContext";
import { ProviderOptionsProvider } from "@/browser/contexts/ProviderOptionsContext";
import { ThinkingProvider } from "@/browser/contexts/ThinkingContext";
import { ConnectionStatusIndicator } from "./ConnectionStatusIndicator";
import { ChatInput } from "./ChatInput/index";
import type { ChatInputAPI } from "./ChatInput/types";
import { ArchivedWorkspaces } from "./ArchivedWorkspaces";

interface ProjectPageProps {
  projectPath: string;
  projectName: string;
  workspaces: FrontendWorkspaceMetadata[];
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
  workspaces,
  onProviderConfig,
  onWorkspaceCreated,
}) => {
  const chatInputRef = useRef<ChatInputAPI | null>(null);

  const handleChatReady = useCallback((api: ChatInputAPI) => {
    chatInputRef.current = api;
    api.focus();
  }, []);

  const archivedWorkspaces = workspaces.filter((w) => w.archived);

  return (
    <ModeProvider projectPath={projectPath}>
      <ProviderOptionsProvider>
        <ThinkingProvider projectPath={projectPath}>
          <div className="flex h-full flex-col">
            {/* Main content area */}
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-5 py-8">
                {/* Archived workspaces section */}
                {archivedWorkspaces.length > 0 && (
                  <ArchivedWorkspaces
                    projectPath={projectPath}
                    projectName={projectName}
                    workspaces={workspaces}
                  />
                )}
              </div>
            </div>

            {/* Chat input pinned to bottom */}
            <div className="shrink-0">
              <ConnectionStatusIndicator />
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
        </ThinkingProvider>
      </ProviderOptionsProvider>
    </ModeProvider>
  );
};
