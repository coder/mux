import React from "react";
import { RUNTIME_MODE, type RuntimeMode } from "@/common/types/runtime";
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "../ui/select";

interface CreationCenterContentProps {
  projectName: string;
  isSending: boolean;
  /** The confirmed workspace name (null while name generation is in progress) */
  workspaceName?: string | null;
  /** Current runtime mode */
  runtimeMode: RuntimeMode;
  /** Callback when runtime mode changes */
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Whether controls are disabled */
  disabled?: boolean;
  /** Content to render in the main area (textarea, etc.) */
  children?: React.ReactNode;
}

/**
 * Header for the creation view showing "New Task in [Runtime Mode]"
 * Runtime mode is selectable via dropdown
 */
export function CreationCenterContent(props: CreationCenterContentProps) {
  if (props.isSending) {
    // Show loading overlay when creating workspace
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-xl px-8 text-center">
          <div className="bg-accent mb-4 inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-current border-r-transparent"></div>
          <h2 className="text-foreground mb-2 text-lg font-medium">Creating workspace</h2>
          <p className="text-muted text-sm leading-relaxed">
            {props.workspaceName ? (
              <code className="bg-separator rounded px-1">{props.workspaceName}</code>
            ) : (
              "Generating name…"
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden p-6">
      {/* Header: New Task in [Runtime Mode dropdown] */}
      <div className="mb-4 flex items-center gap-2">
        <h1 className="text-foreground text-xl font-semibold">New Task in</h1>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value as RuntimeMode)}
          disabled={props.disabled}
        >
          <SelectTrigger className="text-accent hover:text-accent/80 h-auto w-auto gap-1 border-0 bg-transparent p-0 text-xl font-semibold focus:ring-0 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:opacity-100">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={RUNTIME_MODE.WORKTREE}>Git Worktree</SelectItem>
            <SelectItem value={RUNTIME_MODE.SSH}>SSH</SelectItem>
            <SelectItem value={RUNTIME_MODE.LOCAL}>Local</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Main content area - prompt text, with override to allow textarea to grow */}
      <div className="min-h-0 flex-1 overflow-y-auto [&_textarea]:max-h-none [&_textarea]:min-h-[200px] [&_textarea]:flex-1">
        {props.children}
      </div>
    </div>
  );
}
