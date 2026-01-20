import React from "react";
import { cn } from "@/common/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Bell, BookOpen, Globe, List, Pencil, Sparkles, Square, Wrench } from "lucide-react";
import { EmojiIcon } from "../../icons/EmojiIcon";
import { Tooltip, TooltipTrigger, TooltipContent } from "../../ui/tooltip";

/**
 * Shared styled components for tool UI
 * These primitives provide consistent styling across all tool components
 */

interface ToolContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  expanded: boolean;
}

export const ToolContainer: React.FC<ToolContainerProps> = ({ expanded, className, ...props }) => (
  <div
    className={cn(
      "my-2 rounded font-mono text-[11px] transition-all duration-200",
      "[container-type:inline-size]",
      expanded ? "py-2 px-3" : "py-1 px-3",
      className
    )}
    {...props}
  />
);

export const ToolHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn(
      "flex items-center gap-2 cursor-pointer select-none text-secondary hover:text-foreground",
      className
    )}
    {...props}
  />
);

interface ExpandIconProps extends React.HTMLAttributes<HTMLSpanElement> {
  expanded: boolean;
}

export const ExpandIcon: React.FC<ExpandIconProps> = ({ expanded, className, ...props }) => (
  <span
    className={cn(
      "inline-block transition-transform duration-200 text-[10px]",
      expanded ? "rotate-90" : "rotate-0",
      className
    )}
    {...props}
  />
);

export const ToolName: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => <span className={cn("font-medium", className)} {...props} />;

interface StatusIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: string;
}

const getStatusColor = (status: string) => {
  switch (status) {
    case "executing":
      return "text-pending";
    case "completed":
      return "text-success";
    case "failed":
      return "text-danger";
    case "interrupted":
      return "text-interrupted";
    case "backgrounded":
      return "text-backgrounded";
    default:
      return "text-foreground-secondary";
  }
};

export const StatusIndicator: React.FC<StatusIndicatorProps> = ({
  status,
  className,
  children,
  ...props
}) => (
  <span
    className={cn(
      "text-[10px] ml-auto opacity-80 whitespace-nowrap shrink-0",
      "[&_.status-text]:inline [@container(max-width:350px)]:[&_.status-text]:hidden",
      getStatusColor(status),
      className
    )}
    {...props}
  >
    {children}
  </span>
);

export const ToolDetails: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div className={cn("mt-2 pt-2 border-t border-white/5 text-foreground", className)} {...props} />
);

export const DetailSection: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn("my-1.5", className)} {...props} />;

export const DetailLabel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn("text-[10px] text-foreground-secondary mb-1 uppercase tracking-wide", className)}
    {...props}
  />
);

export const DetailContent = React.forwardRef<HTMLPreElement, React.HTMLAttributes<HTMLPreElement>>(
  ({ className, ...props }, ref) => (
    <pre
      ref={ref}
      className={cn(
        "m-0 bg-code-bg rounded-sm text-[11px] leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto",
        className
      )}
      {...props}
    />
  )
);

DetailContent.displayName = "DetailContent";

export const LoadingDots: React.FC<React.HTMLAttributes<HTMLSpanElement>> = ({
  className,
  ...props
}) => (
  <span
    className={cn(
      "after:inline-block after:w-[3ch] after:text-left after:content-[''] after:animate-[ellipsis_1.2s_steps(4,end)_infinite]",
      className
    )}
    {...props}
  />
);

interface HeaderButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

export const HeaderButton: React.FC<HeaderButtonProps> = ({ active, className, ...props }) => (
  <button
    className={cn(
      "border border-white/20 text-foreground px-2 py-0.5 rounded-sm cursor-pointer text-[10px]",
      "transition-all duration-200 whitespace-nowrap hover:bg-white/10 hover:border-white/30",
      active && "bg-white/10",
      className
    )}
    {...props}
  />
);

/**
 * Tool icon with tooltip showing tool name.
 *
 * We deliberately render SVG icons instead of emoji glyphs, since emoji rendering varies
 * widely across platforms and fonts.
 */
interface ToolIconProps {
  toolName: string;
  /**
   * Optional emoji provided by the tool call (e.g. status_set). When present, we render a
   * corresponding icon via EmojiIcon.
   */
  emoji?: string;
  className?: string;
}

const TOOL_NAME_TO_ICON: Partial<Record<string, LucideIcon>> = {
  bash: Wrench,
  bash_output: Wrench,
  bash_background_terminate: Square,
  bash_background_list: List,
  file_read: BookOpen,
  file_edit_insert: Pencil,
  file_edit_replace_string: Pencil,
  file_edit_replace_lines: Pencil,
  todo_write: List,
  web_fetch: Globe,
  web_search: Globe,
  notify: Bell,
};

export const ToolIcon: React.FC<ToolIconProps> = ({ toolName, emoji, className }) => {
  const Icon = TOOL_NAME_TO_ICON[toolName] ?? Sparkles;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex shrink-0 items-center justify-center text-secondary [&_svg]:size-3.5",
            className
          )}
        >
          {emoji ? <EmojiIcon emoji={emoji} /> : <Icon aria-hidden="true" />}
        </span>
      </TooltipTrigger>
      <TooltipContent>{toolName}</TooltipContent>
    </Tooltip>
  );
};

/**
 * Error display box with danger styling
 */
export const ErrorBox: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <div
    className={cn(
      "text-danger bg-danger-overlay border-danger rounded border-l-2 px-2 py-1.5 text-[11px]",
      className
    )}
    {...props}
  />
);

/**
 * Badge for displaying exit codes or process status
 */
interface ExitCodeBadgeProps {
  exitCode: number;
  className?: string;
}

export const ExitCodeBadge: React.FC<ExitCodeBadgeProps> = ({ exitCode, className }) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      exitCode === 0 ? "bg-success text-on-success" : "bg-danger text-on-danger",
      className
    )}
  >
    {exitCode}
  </span>
);

/**
 * Badge for displaying process status (exited, killed, failed, interrupted)
 */
interface ProcessStatusBadgeProps {
  status: "exited" | "killed" | "failed" | "interrupted";
  exitCode?: number;
  className?: string;
}

export const ProcessStatusBadge: React.FC<ProcessStatusBadgeProps> = ({
  status,
  exitCode,
  className,
}) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      status === "exited" && exitCode === 0
        ? "bg-success text-on-success"
        : status === "interrupted"
          ? "bg-warning text-on-warning"
          : "bg-danger text-on-danger",
      className
    )}
  >
    {status}
    {exitCode !== undefined && ` (${exitCode})`}
  </span>
);

/**
 * Badge for output availability status
 */
interface OutputStatusBadgeProps {
  hasOutput: boolean;
  className?: string;
}

export const OutputStatusBadge: React.FC<OutputStatusBadgeProps> = ({ hasOutput, className }) => (
  <span
    className={cn(
      "inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
      hasOutput ? "bg-pending/20 text-pending" : "bg-muted-foreground/20 text-muted-foreground",
      className
    )}
  >
    {hasOutput ? "new output" : "no output"}
  </span>
);

/**
 * Output display section for bash-like tools
 */
interface OutputSectionProps {
  output?: string;
  emptyMessage?: string;
}

export const OutputSection: React.FC<OutputSectionProps> = ({
  output,
  emptyMessage = "No output",
}) => {
  if (output) {
    return (
      <DetailSection>
        <DetailLabel>Output</DetailLabel>
        <DetailContent className="px-2 py-1.5">{output}</DetailContent>
      </DetailSection>
    );
  }

  return (
    <DetailSection>
      <DetailContent className="text-muted px-2 py-1.5 italic">{emptyMessage}</DetailContent>
    </DetailSection>
  );
};
