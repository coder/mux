import React from "react";
import { cn } from "@/common/lib/utils";
import { ExpandIcon, ToolContainer } from "@/browser/features/Tools/Shared/ToolPrimitives";
import type { OperationalBundleInfo } from "@/browser/utils/messages/transcriptRenderProjection";

interface OperationalBundleMessageProps {
  item: OperationalBundleInfo;
  expanded: boolean;
  onToggle: () => void;
}

export function OperationalBundleMessage(props: OperationalBundleMessageProps): React.ReactElement {
  const title =
    props.item.state === "active"
      ? `Running ${props.item.entries.length.toLocaleString()} ${
          props.item.entries.length === 1 ? "operation" : "operations"
        }`
      : props.item.summary.title;
  const details = props.item.entries.length === 1 ? "" : props.item.summary.details;

  return (
    <ToolContainer data-testid="operational-bundle" expanded={false} className="bg-transparent">
      <button
        type="button"
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 text-left text-secondary transition-colors select-none hover:text-foreground",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        )}
        aria-expanded={props.expanded}
        onClick={props.onToggle}
      >
        <ExpandIcon expanded={props.expanded} className="text-muted shrink-0">
          ▶
        </ExpandIcon>
        <span className="text-secondary min-w-0 flex-1 truncate text-sm leading-5">
          <span>{title}</span>
          {details && <span className="text-muted"> · {details}</span>}
        </span>
      </button>
    </ToolContainer>
  );
}
