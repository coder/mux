import React from "react";

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
}

/**
 * Center content displayed during workspace creation
 * Shows either a loading spinner or welcome message
 */
export function CreationCenterContent({ projectName, isSending }: CreationCenterContentProps) {
  return (
    <div className="flex flex-1 items-center justify-center">
      {isSending ? (
        <div className="text-center">
          <div className="bg-accent mb-3 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <p className="text-muted text-sm">Creating workspace...</p>
        </div>
      ) : (
        <div className="max-w-2xl px-8 text-center">
          <h1 className="text-foreground mb-4 text-2xl font-semibold">{projectName}</h1>
          <p className="text-muted text-sm leading-relaxed">
            Describe what you want to build. A new workspace will be created with an automatically
            generated branch name. Configure runtime and model options below.
          </p>
        </div>
      )}
    </div>
  );
}
