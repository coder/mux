import React from "react";

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
  inputPreview?: string;
}

/**
 * Center content displayed during workspace creation
 * Shows either a loading state with the user's prompt or welcome message
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  // Truncate long prompts for preview display
  const truncatedPreview =
    props.inputPreview && props.inputPreview.length > 150
      ? props.inputPreview.slice(0, 150) + "..."
      : props.inputPreview;

  return (
    <div className="flex flex-1 items-center justify-center">
      {props.isSending ? (
        <div className="max-w-xl px-8 text-center">
          <div className="bg-accent mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <h2 className="text-foreground mb-2 text-lg font-medium">Creating workspace</h2>
          {truncatedPreview && (
            <p className="text-muted text-sm leading-relaxed">
              Generating name for &ldquo;{truncatedPreview}&rdquo;
            </p>
          )}
        </div>
      ) : (
        <div className="max-w-2xl px-8 text-center">
          <h1 className="text-foreground mb-4 text-2xl font-semibold">{props.projectName}</h1>
          <p className="text-muted text-sm leading-relaxed">
            Describe what you want to build. A new workspace will be created with an automatically
            generated branch name. Configure runtime and model options below.
          </p>
        </div>
      )}
    </div>
  );
}
