import React, { useState, useMemo } from "react";
import { CodeIcon, TerminalIcon, CheckCircleIcon, XCircleIcon } from "lucide-react";
import { DetailContent } from "./shared/ToolPrimitives";
import { type ToolStatus } from "./shared/toolUtils";
import { HighlightedCode } from "./shared/HighlightedCode";
import { ConsoleOutputDisplay } from "./shared/ConsoleOutput";
import { NestedToolsContainer } from "./shared/NestedToolsContainer";
import type { CodeExecutionResult, NestedToolCall } from "./shared/codeExecutionTypes";
import { cn } from "@/common/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/ui/tooltip";

type ViewMode = "tools" | "result" | "code" | "console";

interface CodeExecutionToolCallProps {
  args: { code: string };
  result?: CodeExecutionResult;
  status?: ToolStatus;
  /** Nested tool calls from streaming (takes precedence over result.toolCalls) */
  nestedCalls?: NestedToolCall[];
}

interface ViewToggleProps {
  active: boolean;
  onClick: () => void;
  tooltip: string;
  children: React.ReactNode;
  variant?: "default" | "success" | "error";
}

const ViewToggle: React.FC<ViewToggleProps> = ({
  active,
  onClick,
  tooltip,
  children,
  variant = "default",
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex h-5 w-5 items-center justify-center p-0.5 transition-colors",
          active && "bg-foreground/10",
          variant === "default" && "text-muted hover:text-foreground",
          variant === "success" && "text-green-400 hover:text-green-300",
          variant === "error" && "text-red-400 hover:text-red-300"
        )}
      >
        {children}
      </button>
    </TooltipTrigger>
    <TooltipContent side="bottom">{tooltip}</TooltipContent>
  </Tooltip>
);

export const CodeExecutionToolCall: React.FC<CodeExecutionToolCallProps> = ({
  args,
  result,
  status = "pending",
  nestedCalls,
}) => {
  // Use streaming nested calls if available, otherwise fall back to result
  const toolCalls = nestedCalls ?? [];
  const consoleOutput = result?.consoleOutput ?? [];
  const hasToolCalls = toolCalls.length > 0;
  const isComplete = status === "completed" || status === "failed";

  // Default to code view only if complete with no tool calls, otherwise show tools
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    isComplete && !hasToolCalls ? "code" : "tools"
  );

  const toggleView = (mode: ViewMode) => {
    // When toggling off, return to tools if available, otherwise code (only if complete)
    const defaultView = hasToolCalls || !isComplete ? "tools" : "code";
    setViewMode((prev) => (prev === mode ? defaultView : mode));
  };

  // Format result for display
  const formattedResult = useMemo(() => {
    if (!result?.success || result.result === undefined) return null;
    return typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result, null, 2);
  }, [result]);

  // Determine result icon and variant
  const resultVariant = !isComplete ? "default" : result?.success ? "success" : "error";

  return (
    <fieldset className="border-foreground/20 mt-3 flex flex-col gap-1.5 rounded-lg border border-dashed px-3 pt-1 pb-2">
      {/* Legend with title and view toggles */}
      <legend className="flex items-center gap-1.5 px-1.5">
        <span className="text-foreground text-xs font-medium">Code Execution</span>
        <div className="flex items-center">
          <div className="mr-0.5">
            <ViewToggle
              active={viewMode === "result"}
              onClick={() => toggleView("result")}
              tooltip="Show Result"
              variant={resultVariant}
            >
              {!isComplete ? (
                <span className="text-xs font-medium">...</span>
              ) : result?.success ? (
                <CheckCircleIcon className="h-3.5 w-3.5" />
              ) : (
                <XCircleIcon className="h-3.5 w-3.5" />
              )}
            </ViewToggle>
          </div>
          {(hasToolCalls || !isComplete) && (
            <ViewToggle
              active={viewMode === "code"}
              onClick={() => toggleView("code")}
              tooltip="Show Code"
            >
              <CodeIcon className="h-3.5 w-3.5" />
            </ViewToggle>
          )}
          <ViewToggle
            active={viewMode === "console"}
            onClick={() => toggleView("console")}
            tooltip="Show Console"
          >
            <TerminalIcon className="h-3.5 w-3.5" />
          </ViewToggle>
        </div>
      </legend>

      {/* Content based on view mode */}
      {viewMode === "tools" && hasToolCalls && <NestedToolsContainer calls={toolCalls} />}

      {viewMode === "code" && (
        <div className="border-foreground/10 bg-code-bg rounded border p-2">
          <HighlightedCode language="javascript" code={args.code} />
        </div>
      )}

      {viewMode === "console" && (
        <div className="border-foreground/10 bg-code-bg rounded border p-2">
          {consoleOutput.length > 0 ? (
            <ConsoleOutputDisplay output={consoleOutput} />
          ) : (
            <span className="text-muted text-xs italic">No console output</span>
          )}
        </div>
      )}

      {viewMode === "result" &&
        (isComplete && result ? (
          result.success ? (
            formattedResult ? (
              <DetailContent className="p-2">{formattedResult}</DetailContent>
            ) : (
              <div className="text-muted text-xs italic">(no return value)</div>
            )
          ) : (
            <DetailContent className="border border-red-500/30 bg-red-500/10 p-2 text-red-400">
              {result.error}
            </DetailContent>
          )
        ) : (
          <div className="text-muted text-xs italic">Execution in progress...</div>
        ))}
    </fieldset>
  );
};
