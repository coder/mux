import React from "react";
import { cn } from "@/common/lib/utils";

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  connectorStartsAtParent: boolean;
  sharedTrunkActiveThroughRow: boolean;
  sharedTrunkActiveBelowRow: boolean;
  ancestorTrunks: ReadonlyArray<{ left: number; active: boolean }>;
  indentLeft: number;
  isSelected: boolean;
  isElbowActive: boolean;
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
      {props.ancestorTrunks.map((trunk, index) => (
        <span
          key={`ancestor-trunk-${index}-${trunk.left}`}
          aria-hidden
          data-testid="ancestor-trunk"
          data-trunk-active={trunk.active}
          className={cn(
            connectorFillClass,
            // Render one full-height trunk per continuing ancestor depth so
            // nested rows stay visually connected to higher-level siblings.
            "pointer-events-none absolute inset-y-0 z-10 w-px",
            trunk.active && "subagent-connector-active"
          )}
          style={
            {
              left: trunk.left,
              "--connector-color": connectorColor,
            } as React.CSSProperties
          }
        />
      ))}
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
              // First siblings extend from the parent row center, while
              // subsequent siblings continue from the previous row boundary to
              // avoid overlapping duplicate trunk segments.
              "absolute left-[6px] w-px",
              props.connectorStartsAtParent ? "-top-1/2" : "top-0",
              props.sharedTrunkActiveThroughRow && "subagent-connector-active"
            )}
            style={{ bottom: `calc(50% + ${connectorTurnSizePx}px)` }}
          />
        )}
        {showPassThroughSegment && (
          <span
            className={cn(
              connectorFillClass,
              "absolute bottom-0 left-[6px] w-px",
              props.sharedTrunkActiveBelowRow && "subagent-connector-active"
            )}
            style={{ top: `calc(50% - ${connectorTurnSizePx}px)` }}
          />
        )}
        {props.isElbowActive ? (
          <svg
            aria-hidden
            className="absolute top-1/2 left-[6px] h-[6px] w-[10px] -translate-y-full"
            viewBox="0 0 10 6"
          >
            <path
              // Border dashes cannot animate their offset, so we draw the
              // rounded elbow as an SVG path and animate stroke-dashoffset.
              className="subagent-connector-elbow-active"
              d="M0.5 0.5 Q0.5 5.5 5.5 5.5 H9.5"
            />
          </svg>
        ) : (
          <span
            className={cn(
              connectorBorderClass,
              // Draw a rounded elbow instead of a hard 90-degree corner where the
              // vertical connector turns into the sub-agent branch.
              "absolute top-1/2 left-[6px] h-[6px] w-[10px] -translate-y-full rounded-bl-[6px] border-l border-b"
            )}
          />
        )}
      </div>
      {props.children}
    </div>
  );
}
