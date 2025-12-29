import React, { useState, useMemo } from "react";
import { CodeIcon, TerminalIcon, CheckCircleIcon, XCircleIcon } from "lucide-react";
import { DetailContent } from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus } from "./shared/toolUtils";
import { HighlightedCode } from "./shared/HighlightedCode";
import { ConsoleOutputDisplay } from "./shared/ConsoleOutput";
import { NestedToolsContainer } from "./shared/NestedToolsContainer";
import type { CodeExecutionResult, NestedToolCall } from "./shared/codeExecutionTypes";
import { cn } from "@/common/lib/utils";

interface CodeExecutionToolCallProps {
  args: { code: string };
  result?: CodeExecutionResult;
  status?: ToolStatus;
  /** Nested tool calls from streaming (takes precedence over result.toolCalls) */
  nestedCalls?: NestedToolCall[];
}

export const CodeExecutionToolCall: React.FC<CodeExecutionToolCallProps> = ({
  args,
  result,
  status = "pending",
  nestedCalls,
}) => {
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(false);

  // Format result for display
  const formattedResult = useMemo(() => {
    if (!result?.success || result.result === undefined) return null;
    return typeof result.result === "string"
      ? result.result
      : JSON.stringify(result.result, null, 2);
  }, [result]);

  const [resultExpanded, setResultExpanded] = useState(false);

  // Use streaming nested calls if available, otherwise fall back to result
  const toolCalls = nestedCalls ?? [];
  const consoleOutput = result?.consoleOutput ?? [];
  const hasToolCalls = toolCalls.length > 0;
  const isComplete = status === "completed" || status === "failed";

  return (
    <fieldset className="border-foreground/20 mt-3 flex flex-col gap-3 rounded-lg border border-dashed px-3 pt-2 pb-3">
      {/* Legend title with status - sits on the border */}
      <legend className="flex items-center gap-2 px-2">
        <span className="text-foreground text-sm font-medium">Code Execution</span>
        <span className="text-muted text-xs">{getStatusDisplay(status)}</span>
      </legend>

      {/* Code - collapsible toggle */}
      <div>
        <button
          type="button"
          onClick={() => setCodeExpanded(!codeExpanded)}
          className="text-muted hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
        >
          <span
            className={cn(
              "text-[10px] transition-transform duration-150",
              codeExpanded && "rotate-90"
            )}
          >
            ▶
          </span>
          <CodeIcon className="h-3 w-3" />
          <span>Show code</span>
        </button>
        {codeExpanded && (
          <div className="border-foreground/10 bg-code-bg mt-2 rounded border p-2">
            <HighlightedCode language="javascript" code={args.code} />
          </div>
        )}
      </div>

      {/* Console Output - collapsible toggle */}
      <div>
        <button
          type="button"
          onClick={() => setConsoleExpanded(!consoleExpanded)}
          className="text-muted hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
        >
          <span
            className={cn(
              "text-[10px] transition-transform duration-150",
              consoleExpanded && "rotate-90"
            )}
          >
            ▶
          </span>
          <TerminalIcon className="h-3 w-3" />
          <span>Console output</span>
          {consoleOutput.length > 0 && <span className="text-muted">({consoleOutput.length})</span>}
        </button>
        {consoleExpanded && (
          <div className="border-foreground/10 bg-code-bg mt-2 rounded border p-2">
            {consoleOutput.length > 0 ? (
              <ConsoleOutputDisplay output={consoleOutput} />
            ) : (
              <span className="text-muted text-xs italic">No output</span>
            )}
          </div>
        )}
      </div>

      {/* Nested tool calls - stream in the middle */}
      {hasToolCalls && <NestedToolsContainer calls={toolCalls} />}

      {/* Result/Error - shown when complete */}
      {isComplete && result && (
        <div>
          <button
            type="button"
            onClick={() => setResultExpanded(!resultExpanded)}
            className={cn(
              "flex items-center gap-1.5 text-xs transition-colors",
              result.success
                ? "text-green-400 hover:text-green-300"
                : "text-red-400 hover:text-red-300"
            )}
          >
            <span
              className={cn(
                "text-[10px] transition-transform duration-150",
                resultExpanded && "rotate-90"
              )}
            >
              ▶
            </span>
            {result.success ? (
              <CheckCircleIcon className="h-3 w-3" />
            ) : (
              <XCircleIcon className="h-3 w-3" />
            )}
            <span>{result.success ? "Result" : "Error"}</span>
          </button>
          {resultExpanded &&
            (result.success ? (
              formattedResult ? (
                <DetailContent className="mt-2 p-2">{formattedResult}</DetailContent>
              ) : (
                <div className="text-muted mt-2 text-xs italic">(no return value)</div>
              )
            ) : (
              <DetailContent className="mt-2 border border-red-500/30 bg-red-500/10 p-2 text-red-400">
                {result.error}
              </DetailContent>
            ))}
        </div>
      )}
    </fieldset>
  );
};
