import React from "react";
import { cn } from "@/common/lib/utils";

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  indentLeft: number;
  isSelected: boolean;
  isActive: boolean;
  children: React.ReactNode;
}

export function SubAgentListItem(props: SubAgentListItemProps) {
  const connectorLeft = props.indentLeft - 10;
  const connectorFillClass = props.isSelected ? "bg-border" : "bg-border-light";
  const connectorBorderClass = props.isSelected ? "border-border" : "border-border-light";
  const connectorColor = props.isSelected ? "var(--color-border)" : "var(--color-border-light)";
  const connectorTurnSizePx = 6;

  // Even when a sub-agent is an only child, we still need the top segment to
  // visually connect it back to the parent row.
  const showTopSegment =
    props.connectorPosition === "middle" ||
    props.connectorPosition === "last" ||
    props.connectorPosition === "single";
  // Middle rows must keep the vertical trunk passing through so the connector
  // continues toward the next sub-agent sibling.
  const showPassThroughSegment = props.connectorPosition === "middle";

  return (
    <div className="relative">
      <div
        aria-hidden
        data-testid="subagent-connector"
        // Keep connectors above the row background so lines remain visible for
        // both selected and unselected sub-agent variants.
        className="pointer-events-none absolute inset-y-0 z-10"
        style={
          {
            left: connectorLeft,
            width: 14,
            "--connector-color": connectorColor,
          } as React.CSSProperties
        }
      >
        {showTopSegment && (
          <span
            className={cn(
              connectorFillClass,
              // Extend upward by half a row so the branch meets the parent row's
              // status-dot center, then stop before the rounded elbow begins.
              "absolute -top-1/2 left-[6px] w-px",
              props.isActive && "subagent-connector-active"
            )}
            style={{ bottom: `calc(50% + ${connectorTurnSizePx}px)` }}
          />
        )}
        {showPassThroughSegment && (
          <span
            className={cn(
              connectorFillClass,
              "absolute bottom-0 left-[6px] w-px",
              props.isActive && "subagent-connector-active"
            )}
            style={{ top: `calc(50% - ${connectorTurnSizePx}px)` }}
          />
        )}
        <span
          className={cn(
            connectorBorderClass,
            // Draw a rounded elbow instead of a hard 90-degree corner where the
            // vertical connector turns into the sub-agent branch.
            "absolute top-1/2 left-[6px] h-[6px] w-[10px] -translate-y-full rounded-bl-[6px] border-l border-b",
            props.isActive && "border-dashed"
          )}
        />
      </div>
      {props.children}
    </div>
  );
}
