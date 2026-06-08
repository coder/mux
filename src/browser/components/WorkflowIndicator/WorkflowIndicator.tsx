import React from "react";
import { Workflow } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/browser/components/Popover/Popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { CUSTOM_EVENTS, createCustomEvent } from "@/common/constants/events";
import { cn } from "@/common/lib/utils";

import {
  useWorkflowWorkspaceSnapshot,
  type WorkflowWorkspaceSnapshot,
} from "@/browser/features/Workflows/WorkflowStore";
import { getWorkflowStatusPresentation } from "@/browser/features/Workflows/workflowStatusPresentation";

interface WorkflowIndicatorProps {
  workspaceId: string;
}

interface WorkflowIndicatorViewProps {
  workspaceId: string;
  snapshot: WorkflowWorkspaceSnapshot;
  onOpenWorkflowsTab?: () => void;
}

export function WorkflowIndicator(props: WorkflowIndicatorProps) {
  const snapshot = useWorkflowWorkspaceSnapshot(props.workspaceId);
  return <WorkflowIndicatorView workspaceId={props.workspaceId} snapshot={snapshot} />;
}

export function WorkflowIndicatorView(props: WorkflowIndicatorViewProps) {
  const [open, setOpen] = React.useState(false);
  const problemCount = props.snapshot.summary.problemCount;
  const activeCount = props.snapshot.summary.activeCount;
  const hasProblems = problemCount > 0;
  const hasActive = activeCount > 0;
  const badgeCount = hasProblems ? problemCount : activeCount;
  const label = hasProblems
    ? `${problemCount} workflow${problemCount === 1 ? "" : "s"} ${problemCount === 1 ? "needs" : "need"} attention`
    : hasActive
      ? `${activeCount} active workflow${activeCount === 1 ? "" : "s"}`
      : "Workflows";

  const openWorkflowsTab = () => {
    setOpen(false);
    if (props.onOpenWorkflowsTab) {
      props.onOpenWorkflowsTab();
      return;
    }
    window.dispatchEvent(
      createCustomEvent(CUSTOM_EVENTS.OPEN_WORKFLOWS_TAB, { workspaceId: props.workspaceId })
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "relative flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-sidebar-hover hover:text-foreground max-[520px]:hidden",
                hasProblems && "text-error",
                !hasProblems && hasActive && "text-success"
              )}
              aria-label={label}
            >
              <Workflow className="h-3.5 w-3.5" />
              {(hasProblems || hasActive) && (
                <span className="bg-background counter-nums absolute -top-1 -right-1 min-w-3 rounded-full px-0.5 text-[9px] leading-3">
                  {badgeCount}
                </span>
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end">
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="bottom"
        align="end"
        className="bg-modal-bg border-separator-light w-72 overflow-visible rounded px-3 py-2 text-xs font-normal shadow-[0_2px_8px_rgba(0,0,0,0.4)]"
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-foreground font-medium">Workflows</div>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={openWorkflowsTab}
            >
              Open tab
            </button>
          </div>
          <IndicatorSection title="Active and attention">
            {props.snapshot.currentRuns.length === 0 ? (
              <p className="text-muted">No active workflows</p>
            ) : (
              props.snapshot.currentRuns.slice(0, 5).map((run) => {
                const presentation = getWorkflowStatusPresentation(run.status);
                return (
                  <div key={run.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{run.definition.name}</span>
                    <span className="text-muted shrink-0">{presentation.label}</span>
                  </div>
                );
              })
            )}
          </IndicatorSection>
          <IndicatorSection title="Available definitions">
            {props.snapshot.definitions.length === 0 ? (
              <p className="text-muted">No definitions found</p>
            ) : (
              <p className="text-muted">
                {props.snapshot.definitionGroups.project.length} project ·{" "}
                {props.snapshot.definitionGroups.global.length} global ·{" "}
                {props.snapshot.definitionGroups["built-in"].length} built-in ·{" "}
                {props.snapshot.definitionGroups.scratch.length} scratch
              </p>
            )}
          </IndicatorSection>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function IndicatorSection(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-muted text-[11px] font-semibold tracking-wide uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}
