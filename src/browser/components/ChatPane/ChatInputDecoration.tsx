import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";

interface ChatInputDecorationProps {
  expanded: boolean;
  onToggle: () => void;
  summary: ReactNode;
  renderExpanded?: () => ReactNode;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
  dataComponent?: string;
}

// Keep collapsible decorations aligned with the chat input gutter so swapping
// between pending reviews, queued messages, and background bash banners does
// not make the stack jump horizontally in collapsed state. Encapsulating the
// shared wrapper/button structure here also prevents the collapsed chrome from
// drifting again as individual decorations evolve, while `renderExpanded`
// keeps large hidden detail trees out of collapsed rerenders.
export function ChatInputDecoration(props: ChatInputDecorationProps) {
  return (
    <div
      className={cn("border-border bg-surface-primary border-t px-4", props.className)}
      data-component={props.dataComponent}
    >
      <button
        type="button"
        onClick={props.onToggle}
        className={cn(
          // Use a fixed collapsed row height so every decoration reads with the
          // same top/bottom breathing room regardless of icon/text mix.
          "group mx-auto flex h-6 w-full max-w-4xl items-center gap-2 text-xs leading-none transition-colors",
          props.summaryClassName
        )}
      >
        {props.summary}
        <div className="ml-auto">
          {props.expanded ? (
            <ChevronDown className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          ) : (
            <ChevronRight className="text-muted group-hover:text-secondary size-3.5 transition-colors" />
          )}
        </div>
      </button>
      {props.expanded && props.renderExpanded && (
        <div className={cn("mx-auto max-w-4xl", props.contentClassName)}>
          {props.renderExpanded()}
        </div>
      )}
    </div>
  );
}
