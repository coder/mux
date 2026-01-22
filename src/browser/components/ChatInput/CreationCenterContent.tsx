import React from "react";

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
  /** The confirmed workspace name (null while generation is in progress) */
  workspaceName?: string | null;
  /** The confirmed workspace title (null while generation is in progress) */
  workspaceTitle?: string | null;
}

/**
 * Loading overlay displayed during workspace creation.
 * Shown as an overlay when isSending is true.
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  // Only render when actually sending/creating
  if (!props.isSending) {
    return null;
  }

  return (
    <div className="bg-bg-dark/80 fixed inset-0 z-10 flex items-center justify-center backdrop-blur-sm">
      <div className="max-w-xl px-8 text-center">
        <div className="bg-accent mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
        <h2 className="text-foreground mb-2 text-lg font-medium">Creating workspace</h2>
        <p className="text-muted text-sm leading-relaxed">
          {props.workspaceName ? (
            <>
              <code className="bg-separator rounded px-1">{props.workspaceName}</code>
              {props.workspaceTitle && (
                <span className="text-muted-foreground ml-1">— {props.workspaceTitle}</span>
              )}
            </>
          ) : (
            "Generating name…"
          )}
        </p>
      </div>
    </div>
  );
}
