import React from "react";

interface CreationCenterContentProps {
  projectName: string;
}

/**
 * Center content displayed during workspace creation - header above input
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="max-w-2xl px-8 text-center">
        <h1 className="text-foreground mb-4 text-2xl font-semibold">{props.projectName}</h1>
        <p className="text-muted text-sm leading-relaxed">
          Describe what you want to build and a workspace will be created.
        </p>
      </div>
    </div>
  );
}
