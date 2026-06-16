import React, { useState } from "react";

import type { WorkflowActionDescriptor, WorkflowActionEffect } from "@/common/types/workflow";
import type {
  WorkflowActionListToolArgs,
  WorkflowActionListToolResult,
  WorkflowActionListToolSuccessResult,
} from "@/common/types/tools";
import { formatDuration } from "@/common/utils/formatDuration";

import {
  ErrorBox,
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
  ToolName,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, isToolErrorResult, type ToolStatus } from "./Shared/toolUtils";
import {
  WorkflowBadge,
  WorkflowJsonBlock,
  WorkflowKindBadge,
  WorkflowLoadingState,
  WorkflowSection,
  useAutoCollapsingWorkflowLookup,
} from "./WorkflowDefinitionToolCall";

interface WorkflowActionListToolCallProps {
  args: WorkflowActionListToolArgs;
  result?: WorkflowActionListToolResult;
  status?: ToolStatus;
}

/** Risk-ordered tones: reads are safe, workspace mutates local state, external leaves the machine. */
const EFFECT_TONE: Record<WorkflowActionEffect, "success" | "normal" | "warning"> = {
  read: "success",
  workspace: "normal",
  external: "warning",
};

function formatWorkflowActionCount(count: number): string {
  return count === 1 ? "1 action" : `${count} actions`;
}

function WorkflowActionDetails(props: { descriptor: WorkflowActionDescriptor }) {
  const action = props.descriptor;
  return (
    <div className="px-2 pb-2 pl-7">
      <div className="text-muted truncate font-mono text-[10px]" title={action.sourcePath}>
        {action.sourcePath}
      </div>
      {action.executable ? (
        <>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <WorkflowBadge>v{action.metadata.version}</WorkflowBadge>
            {action.metadata.timeoutMs != null && (
              <WorkflowBadge>timeout {formatDuration(action.metadata.timeoutMs)}</WorkflowBadge>
            )}
            {action.hasReconcile && <WorkflowBadge tone="success">reconcile</WorkflowBadge>}
          </div>
          {action.metadata.inputSchema != null && (
            <WorkflowSection title="Input schema">
              <WorkflowJsonBlock
                value={action.metadata.inputSchema}
                className="max-h-[160px]"
                ariaLabel={`${action.name} input schema`}
              />
            </WorkflowSection>
          )}
          {action.metadata.outputSchema != null && (
            <WorkflowSection title="Output schema">
              <WorkflowJsonBlock
                value={action.metadata.outputSchema}
                className="max-h-[160px]"
                ariaLabel={`${action.name} output schema`}
              />
            </WorkflowSection>
          )}
          {action.metadata.permissions != null && (
            <WorkflowSection title="Permissions">
              <WorkflowJsonBlock
                value={action.metadata.permissions}
                className="max-h-[160px]"
                ariaLabel={`${action.name} permissions`}
              />
            </WorkflowSection>
          )}
        </>
      ) : (
        <div className="text-warning mt-1.5 text-[10px]">{action.blockedReason}</div>
      )}
    </div>
  );
}

function WorkflowActionListRow(props: { descriptor: WorkflowActionDescriptor }) {
  const action = props.descriptor;
  // Self-contained per-row expansion: schemas are the bulk of the payload, so they
  // stay hidden until the user drills into a specific action.
  const [expanded, setExpanded] = useState(false);
  const description = action.executable ? action.metadata.description : action.blockedReason;
  return (
    <div>
      {/* Badges share one flex cell so they keep natural width, and the narrow
          layout pins the truncating description to the minmax(0,1fr) span below
          the name — putting nowrap text in an `auto` column would inflate it to
          the text's full width and push the other cells off-screen. */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(8rem,16rem)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 px-2 py-1.5 text-left hover:bg-white/5 [@container(max-width:640px)]:grid-cols-[auto_minmax(0,1fr)_auto]"
      >
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <span className="text-foreground truncate font-mono text-[12px] font-medium">
          {action.name}
        </span>
        {/* span (not div): buttons only allow phrasing content */}
        <span className="flex items-center gap-1.5">
          <WorkflowBadge>{action.scope}</WorkflowBadge>
          {action.executable ? (
            <WorkflowBadge tone={EFFECT_TONE[action.metadata.effect]}>
              {action.metadata.effect}
            </WorkflowBadge>
          ) : (
            <WorkflowBadge tone="warning">blocked</WorkflowBadge>
          )}
        </span>
        <span
          className="text-muted truncate text-[11px] [@container(max-width:640px)]:col-span-2 [@container(max-width:640px)]:col-start-2"
          title={description}
        >
          {description}
        </span>
      </button>
      {expanded && <WorkflowActionDetails descriptor={action} />}
    </div>
  );
}

function WorkflowActionList(props: { actions: WorkflowActionDescriptor[] }) {
  return (
    <div className="border-border bg-background/20 rounded border">
      <div className="divide-border/60 divide-y">
        {props.actions.map((action) => (
          <WorkflowActionListRow key={`${action.scope}:${action.name}`} descriptor={action} />
        ))}
      </div>
    </div>
  );
}

function isWorkflowActionListSuccessResult(
  value: WorkflowActionListToolResult | undefined
): value is WorkflowActionListToolSuccessResult {
  return value != null && !isToolErrorResult(value);
}

export const WorkflowActionListToolCall: React.FC<WorkflowActionListToolCallProps> = ({
  result,
  status = "pending",
}) => {
  const { expanded, toggleExpanded } = useAutoCollapsingWorkflowLookup(status);
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isWorkflowActionListSuccessResult(result) ? result : null;
  const actions = successResult?.actions ?? [];

  return (
    <ToolContainer expanded={expanded}>
      <ToolHeader onClick={toggleExpanded}>
        <ExpandIcon expanded={expanded}>▶</ExpandIcon>
        <ToolIcon toolName="workflow_action_list" />
        <WorkflowKindBadge />
        <ToolName>actions</ToolName>
        {actions.length > 0 && (
          <span className="text-muted text-[10px]">
            {formatWorkflowActionCount(actions.length)}
          </span>
        )}
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {expanded && (
        <ToolDetails>
          {actions.length > 0 ? (
            <WorkflowActionList actions={actions} />
          ) : status === "executing" ? (
            <WorkflowLoadingState />
          ) : (
            <div className="text-muted text-[11px] italic">No workflow actions returned.</div>
          )}
          {errorResult && <ErrorBox className="mt-2">{errorResult.error}</ErrorBox>}
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
