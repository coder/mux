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
  const connectorBorderClass = props.isSelected ? "border-border" : "border-border-subtle";
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
        className="pointer-events-none absolute inset-y-0"
        style={{ left: connectorLeft, width: 14 }}
      >
        {showTopSegment && (
          <span className={cn(connectorBorderClass, "absolute top-0 left-[6px] h-1/2 border-l")} />
        )}
        {showBottomSegment && (
          <span
            className={cn(connectorBorderClass, "absolute top-1/2 left-[6px] bottom-0 border-l")}
          />
        )}
        <span className={cn(connectorBorderClass, "absolute top-1/2 left-[6px] w-2.5 border-t")} />
      </div>
      {props.children}
    </div>
  );
}
