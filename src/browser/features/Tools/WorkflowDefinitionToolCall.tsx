import React from "react";

import type { WorkflowDefinitionDescriptor } from "@/common/types/workflow";
import type {
  WorkflowListToolArgs,
  WorkflowListToolResult,
  WorkflowListToolSuccessResult,
  WorkflowReadToolArgs,
  WorkflowReadToolResult,
  WorkflowReadToolSuccessResult,
} from "@/common/types/tools";
import { cn } from "@/common/lib/utils";

import {
  DetailSection,
  ErrorBox,
  ExpandIcon,
  LoadingDots,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import {
  getStatusDisplay,
  isToolErrorResult,
  type ToolStatus,
  useAutoCollapsingToolExpansion,
} from "./Shared/toolUtils";
import { HighlightedCode, JsonHighlight } from "./Shared/HighlightedCode";

interface WorkflowListToolCallProps {
  args: WorkflowListToolArgs;
  result?: WorkflowListToolResult;
  status?: ToolStatus;
}

interface WorkflowReadToolCallProps {
  args: WorkflowReadToolArgs;
  result?: WorkflowReadToolResult;
  status?: ToolStatus;
}

export const WORKFLOW_ACTION_BUTTON_CLASS =
  "text-muted hover:text-foreground border-border rounded border px-2 py-1 disabled:opacity-50 disabled:hover:text-muted";

export type WorkflowPromotionTarget = "project" | "global";

export function WorkflowKindBadge() {
  return (
    <span className="border-border-light text-plan-mode shrink-0 rounded border px-1 py-0.5 text-[9px] tracking-wide uppercase">
      Workflow
    </span>
  );
}

export function WorkflowBadge(props: {
  children: React.ReactNode;
  tone?: "normal" | "success" | "warning";
}) {
  return (
    <span
      className={cn(
        "border-border bg-background/40 rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        props.tone === "success" && "border-success/30 text-success",
        props.tone === "warning" && "border-warning/30 text-warning",
        (props.tone == null || props.tone === "normal") && "text-muted"
      )}
    >
      {props.children}
    </span>
  );
}

export function WorkflowSection(props: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <DetailSection className={props.className}>
      <div className="text-muted mb-1 text-[10px] tracking-wide uppercase">{props.title}</div>
      {props.children}
    </DetailSection>
  );
}

export function WorkflowJsonBlock(props: {
  value: unknown;
  className?: string;
  ariaLabel?: string;
}) {
  const isNamedScrollRegion = props.ariaLabel != null;
  return (
    <div
      className={cn(
        "border-border bg-code-bg max-h-[240px] overflow-auto rounded border p-2",
        props.className
      )}
      role={isNamedScrollRegion ? "region" : undefined}
      tabIndex={isNamedScrollRegion ? 0 : undefined}
      aria-label={props.ariaLabel}
    >
      <JsonHighlight value={props.value} />
    </div>
  );
}

export function WorkflowSourceBlock(props: {
  source: string;
  title?: string;
  className?: string;
  maxHeightClassName?: string;
}) {
  const source = props.source.trimEnd();
  return (
    <WorkflowSection title={props.title ?? "Source"} className={props.className}>
      <div
        className={cn(
          "border-border bg-code-bg overflow-auto rounded border p-2",
          props.maxHeightClassName ?? "max-h-[420px]"
        )}
      >
        <HighlightedCode language="javascript" code={source} showLineNumbers />
      </div>
    </WorkflowSection>
  );
}

function formatWorkflowDefinitionCount(count: number): string {
  return count === 1 ? "1 definition" : `${count} definitions`;
}

export function formatWorkflowSavedMessage(scope: WorkflowPromotionTarget): string {
  return scope === "project" ? "Saved to project workflows" : "Saved to global workflows";
}

function WorkflowDefinitionListRow(props: { descriptor: WorkflowDefinitionDescriptor }) {
  const descriptor = props.descriptor;
  // Badges live in a flex wrapper (not their own grid cells) so they keep their
  // natural width on narrow containers instead of stretching to the cell width.
  // Narrow layout: "name [badges]" on one row, description spanning a second row.
  return (
    <div className="grid grid-cols-[minmax(8rem,16rem)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2 py-1.5 [@container(max-width:640px)]:grid-cols-[minmax(0,1fr)_auto]">
      <span className="text-foreground truncate font-mono text-[12px] font-medium">
        {descriptor.name}
      </span>
      <div className="flex items-center gap-1.5">
        <WorkflowBadge>{descriptor.scope}</WorkflowBadge>
        {!descriptor.executable && <WorkflowBadge tone="warning">blocked</WorkflowBadge>}
      </div>
      <div className="min-w-0 [@container(max-width:640px)]:col-span-2">
        <div className="text-muted truncate text-[11px]" title={descriptor.description}>
          {descriptor.description}
        </div>
        {descriptor.blockedReason && (
          <div
            className="text-warning mt-0.5 truncate text-[10px]"
            title={descriptor.blockedReason}
          >
            {descriptor.blockedReason}
          </div>
        )}
      </div>
    </div>
  );
}

function WorkflowDefinitionList(props: { workflows: WorkflowDefinitionDescriptor[] }) {
  return (
    <div className="border-border bg-background/20 rounded border">
      <div className="divide-border/60 divide-y">
        {props.workflows.map((workflow) => (
          <WorkflowDefinitionListRow
            key={`${workflow.scope}:${workflow.name}`}
            descriptor={workflow}
          />
        ))}
      </div>
    </div>
  );
}

export function WorkflowDefinitionCard(props: {
  descriptor: WorkflowDefinitionDescriptor;
  compact?: boolean;
}) {
  const descriptor = props.descriptor;
  return (
    <div className="border-border bg-background/30 rounded border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-foreground font-mono text-[12px] font-medium">{descriptor.name}</span>
        <WorkflowBadge>{descriptor.scope}</WorkflowBadge>
        {!descriptor.executable && <WorkflowBadge tone="warning">blocked</WorkflowBadge>}
      </div>
      {!props.compact && (
        <div className="text-muted mt-1 text-[11px]">{descriptor.description}</div>
      )}
      {descriptor.sourcePath && (
        <div className="text-muted mt-1 truncate font-mono text-[10px]">
          {descriptor.sourcePath}
        </div>
      )}
      {descriptor.blockedReason && (
        <div className="text-warning mt-1 text-[10px]">{descriptor.blockedReason}</div>
      )}
    </div>
  );
}

function isWorkflowListSuccessResult(
  value: WorkflowListToolResult | undefined
): value is WorkflowListToolSuccessResult {
  return value != null && !isToolErrorResult(value);
}

function isWorkflowReadSuccessResult(
  value: WorkflowReadToolResult | undefined
): value is WorkflowReadToolSuccessResult {
  return value != null && !isToolErrorResult(value);
}

const AUTO_COLLAPSE_WORKFLOW_LOOKUP_STATUSES = new Set<ToolStatus>(["completed"]);

export function useAutoCollapsingWorkflowLookup(status: ToolStatus) {
  // Completed workflow lookup/action payloads can be bulky, so collapse them for
  // transcript scanability without writing that automatic presentation choice to
  // the user's sticky expansion preference. Header clicks still persist intent.
  return useAutoCollapsingToolExpansion(true, {
    autoCollapsed: AUTO_COLLAPSE_WORKFLOW_LOOKUP_STATUSES.has(status),
    resetKey: undefined,
  });
}

export function WorkflowLoadingState() {
  return (
    <div className="text-muted text-[11px] italic">
      Waiting for workflow result
      <LoadingDots />
    </div>
  );
}

export const WorkflowListToolCall: React.FC<WorkflowListToolCallProps> = ({
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useAutoCollapsingWorkflowLookup(status);
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isWorkflowListSuccessResult(result) ? result : null;
  const workflows = successResult?.workflows ?? [];

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="workflow_list" />
        <WorkflowKindBadge />
        <ToolName>list</ToolName>
        {workflows.length > 0 && (
          <span className="text-muted text-[10px]">
            {formatWorkflowDefinitionCount(workflows.length)}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {workflows.length > 0 ? (
            <WorkflowDefinitionList workflows={workflows} />
          ) : status === "executing" ? (
            <WorkflowLoadingState />
          ) : (
            <div className="text-muted text-[11px] italic">No workflow definitions returned.</div>
          )}
          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};

export const WorkflowReadToolCall: React.FC<WorkflowReadToolCallProps> = ({
  args,
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useAutoCollapsingWorkflowLookup(status);
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isWorkflowReadSuccessResult(result) ? result : null;

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="workflow_read" />
        <WorkflowKindBadge />
        <ToolName>{args.name}</ToolName>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {successResult ? (
            <>
              <WorkflowSection title="Definition">
                <WorkflowDefinitionCard descriptor={successResult.descriptor} />
              </WorkflowSection>
              <WorkflowSourceBlock source={successResult.source} />
            </>
          ) : status === "executing" ? (
            <WorkflowLoadingState />
          ) : null}
          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
