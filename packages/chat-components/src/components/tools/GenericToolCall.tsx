import React, { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, FileEdit, FileText, Globe, Search, CheckSquare } from "lucide-react";
import { cn } from "@/utils/cn";
import type { DisplayedToolMessage } from "@/types";

interface GenericToolCallProps {
  message: DisplayedToolMessage;
  className?: string;
}

/**
 * Generic tool call component for shared/read-only rendering.
 * Provides basic visualization for any tool type.
 */
export const GenericToolCall: React.FC<GenericToolCallProps> = ({ message, className }) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const toolName = message.toolName;
  const args = message.args;
  const result = message.result;
  const status = message.status;

  const icon = getToolIcon(toolName);
  const displayName = formatToolName(toolName);
  const summary = getToolSummary(toolName, args);

  return (
    <div className={cn("my-2 rounded border border-border bg-card/50", className)}>
      {/* Header */}
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-accent/30",
          "select-none text-sm"
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span className="text-muted">{icon}</span>
        <span className="font-medium">{displayName}</span>
        {summary && <span className="text-muted text-xs truncate flex-1">{String(summary)}</span>}
        <StatusBadge status={status} />
        <span className="text-muted">
          {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
      </div>

      {/* Expandable content */}
      {isExpanded && (
        <div className="border-t border-border px-3 py-2 text-xs">
          {/* Args */}
          {args !== undefined && args !== null && (
            <div className="mb-2">
              <div className="text-muted font-medium mb-1">Arguments:</div>
              <pre className="bg-code-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {/* Result */}
          {result !== undefined && result !== null && (
            <div>
              <div className="text-muted font-medium mb-1">Result:</div>
              <pre className="bg-code-bg rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

interface StatusBadgeProps {
  status: DisplayedToolMessage["status"];
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const statusConfig = {
    executing: { label: "Running", className: "bg-yellow-500/20 text-yellow-500" },
    completed: { label: "Done", className: "bg-green-500/20 text-green-500" },
    error: { label: "Error", className: "bg-red-500/20 text-red-500" },
  };

  const config = statusConfig[status];
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", config.className)}>
      {config.label}
    </span>
  );
};

/**
 * Get appropriate icon for tool type.
 */
function getToolIcon(toolName: string): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    bash: <Terminal className="h-4 w-4" />,
    file_edit: <FileEdit className="h-4 w-4" />,
    file_edit_insert: <FileEdit className="h-4 w-4" />,
    file_edit_replace_string: <FileEdit className="h-4 w-4" />,
    file_read: <FileText className="h-4 w-4" />,
    web_fetch: <Globe className="h-4 w-4" />,
    web_search: <Search className="h-4 w-4" />,
    todo_write: <CheckSquare className="h-4 w-4" />,
  };

  return iconMap[toolName] ?? <Terminal className="h-4 w-4" />;
}

/**
 * Format tool name for display.
 */
function formatToolName(toolName: string): string {
  const displayNames: Record<string, string> = {
    bash: "Bash",
    file_edit: "File Edit",
    file_edit_insert: "Insert",
    file_edit_replace_string: "Replace",
    file_read: "Read File",
    web_fetch: "Fetch URL",
    web_search: "Search",
    todo_write: "TODO",
    task: "Task",
    propose_plan: "Plan",
    code_execution: "Execute",
  };

  return displayNames[toolName] ?? toolName.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Get a summary line for the tool call.
 */
function getToolSummary(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null;

  const a = args as Record<string, unknown>;

  switch (toolName) {
    case "bash":
      return typeof a.script === "string" ? truncate(a.script.split("\n")[0] ?? "", 60) : null;
    case "file_read":
    case "file_edit":
    case "file_edit_insert":
    case "file_edit_replace_string":
      return typeof a.file_path === "string" || typeof a.filePath === "string"
        ? (a.file_path ?? a.filePath) as string
        : null;
    case "web_fetch":
      return typeof a.url === "string" ? a.url : null;
    case "web_search":
      return typeof a.query === "string" ? a.query : null;
    default:
      return null;
  }
}

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len) + "..." : str;
}
