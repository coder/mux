import React from "react";
import { cn } from "@/common/lib/utils";

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  indentLeft: number;
  isSelected: boolean;
  children: React.ReactNode;
}

export function SubAgentListItem(props: SubAgentListItemProps) {
  const connectorLeft = props.indentLeft - 10;
  const connectorColorClass = props.isSelected ? "bg-border" : "bg-border-light";
  // Even when a sub-agent is an only child, we still need the top segment to
  // visually connect it back to the parent row.
  const showTopSegment =
    props.connectorPosition === "middle" ||
    props.connectorPosition === "last" ||
    props.connectorPosition === "single";
  const showBottomSegment = props.connectorPosition === "middle";

  return (
    <div className="relative">
      <div
        aria-hidden
        // Keep connectors above the row background so lines remain visible for
        // both selected and unselected sub-agent variants.
        className="pointer-events-none absolute inset-y-0 z-10"
        style={{ left: connectorLeft, width: 14 }}
      >
        {showTopSegment && (
          <span className={cn(connectorColorClass, "absolute top-0 left-[6px] h-1/2 w-px")} />
        )}
        {showBottomSegment && (
          <span className={cn(connectorColorClass, "absolute top-1/2 bottom-0 left-[6px] w-px")} />
        )}
        <span className={cn(connectorColorClass, "absolute top-1/2 left-[6px] h-px w-2.5")} />
      </div>
      {props.children}
    </div>
  );
}
