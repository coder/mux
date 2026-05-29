import React from "react";
import { cn } from "@/common/lib/utils";

interface SubAgentListItemProps {
  connectorPosition: "single" | "middle" | "last";
  connectorStartsAtParent: boolean;
  sharedTrunkActiveThroughRow: boolean;
  sharedTrunkActiveBelowRow: boolean;
  ancestorTrunks: ReadonlyArray<{ left: number; active: boolean }>;
  connectorRailX: number;
  childStatusCenterX: number;
  isSelected: boolean;
  isElbowActive: boolean;
  children: React.ReactNode;
}

function getConnectorElbowPath(opts: {
  bendsRight: boolean;
  width: number;
  height: number;
}): string {
  const maxX = Math.max(0.5, opts.width - 0.5);
  const maxY = Math.max(0.5, opts.height - 0.5);
  const cornerX = Math.min(maxY, maxX);

  if (opts.bendsRight) {
    return `M0.5 0.5 Q0.5 ${maxY} ${cornerX} ${maxY} H${maxX}`;
  }

  const leftCurveEndX = Math.max(0.5, maxX - cornerX);
  return `M${maxX} 0.5 Q${maxX} ${maxY} ${leftCurveEndX} ${maxY} H0.5`;
}

export function SubAgentListItem(props: SubAgentListItemProps) {
  const connectorFillClass = props.isSelected ? "bg-border" : "bg-border-light";
  const connectorBorderClass = props.isSelected ? "border-border" : "border-border-light";
  const connectorColor = props.isSelected ? "var(--color-border)" : "var(--color-border-light)";
  const connectorTurnSizePx = 6;

  // Middle rows must keep the vertical trunk passing through so the connector
  // continues toward the next sub-agent sibling.
  const showPassThroughSegment = props.connectorPosition === "middle";
  const elbowLeft = Math.min(props.connectorRailX, props.childStatusCenterX);
  const elbowWidth = Math.max(1, Math.abs(props.childStatusCenterX - props.connectorRailX));
  const elbowBendsRight = props.childStatusCenterX >= props.connectorRailX;

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
        className="pointer-events-none absolute inset-y-0 right-0 left-0 z-10"
        style={{ "--connector-color": connectorColor } as React.CSSProperties}
      >
        {/* The top segment is always rendered (every connectorPosition variant
            needs it) to visually connect this row back to the parent. */}
        <span
          data-testid="subagent-connector-top-segment"
          className={cn(
            connectorFillClass,
            // First siblings extend from the parent row center, while
            // subsequent siblings continue from the previous row boundary to
            // avoid overlapping duplicate trunk segments.
            "absolute w-px",
            props.connectorStartsAtParent ? "-top-1/2" : "top-0",
            props.sharedTrunkActiveThroughRow && "subagent-connector-active"
          )}
          style={{
            left: props.connectorRailX,
            bottom: `calc(50% + ${connectorTurnSizePx}px)`,
          }}
        />
        {showPassThroughSegment && (
          <span
            data-testid="subagent-connector-pass-through"
            className={cn(
              connectorFillClass,
              "absolute bottom-0 w-px",
              props.sharedTrunkActiveBelowRow && "subagent-connector-active"
            )}
            style={{
              left: props.connectorRailX,
              top: `calc(50% - ${connectorTurnSizePx}px)`,
            }}
          />
        )}
        {props.isElbowActive ? (
          <svg
            aria-hidden
            data-testid="subagent-connector-elbow"
            className="absolute top-1/2 h-[6px] -translate-y-full"
            style={{ left: elbowLeft, width: elbowWidth }}
            viewBox={`0 0 ${elbowWidth} ${connectorTurnSizePx}`}
          >
            <path
              // Border dashes cannot animate their offset, so we draw the
              // rounded elbow as an SVG path and animate stroke-dashoffset.
              className="subagent-connector-elbow-active"
              d={getConnectorElbowPath({
                bendsRight: elbowBendsRight,
                width: elbowWidth,
                height: connectorTurnSizePx,
              })}
            />
          </svg>
        ) : (
          <span
            data-testid="subagent-connector-elbow"
            className={cn(
              connectorBorderClass,
              // Draw a rounded elbow instead of a hard 90-degree corner where the
              // vertical connector turns into the sub-agent branch.
              "absolute top-1/2 h-[6px] -translate-y-full border-b",
              elbowBendsRight ? "rounded-bl-[6px] border-l" : "rounded-br-[6px] border-r"
            )}
            style={{ left: elbowLeft, width: elbowWidth }}
          />
        )}
      </div>
      {props.children}
    </div>
  );
}
