import React from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  FileText,
  GitBranch,
  Layers,
  ListTree,
  X,
  Zap,
} from "lucide-react";

import { MarkdownRenderer } from "@/browser/features/Messages/MarkdownRenderer";
import { WorkflowJsonBlock } from "@/browser/features/Tools/WorkflowToolShared";

import { WorkflowLiveDot } from "./WorkflowBadges";
import type { WorkflowPhaseView, WorkflowRunView, WorkflowStepView } from "./projectWorkflowRun";
import {
  WORKFLOW_TONE_VAR,
  formatWorkflowCost,
  formatWorkflowDuration,
  formatWorkflowTokens,
  getWorkflowStepTone,
  hasDisplayableWorkflowReport,
  workflowStructuredOutputEntries,
} from "./workflowDisplay";

const ASK_MODE_BORDER = "color-mix(in srgb, var(--color-ask-mode) 35%, transparent)";

const WorkflowStepNode: React.FC<{ step: WorkflowStepView; color: string }> = (props) => {
  if (props.step.status === "running") {
    return <WorkflowLiveDot />;
  }
  if (props.step.status === "completed") {
    return <Check className="h-2.5 w-2.5" style={{ color: props.color }} />;
  }
  if (props.step.status === "failed") {
    return <X className="h-2.5 w-2.5" style={{ color: props.color }} />;
  }
  // interrupted
  return <span className="h-1.5 w-1.5 rounded-full" style={{ background: props.color }} />;
};

/**
 * Disclosure state that opens when `failed` is initially true AND auto-opens if the value
 * transitions to true later — e.g. a live run whose phase/step fails after it first mounted while
 * running, where a plain `useState(failed)` would keep the stale collapsed state. Uses React's
 * "adjust state during render" pattern (no effect). The user can still collapse it afterward;
 * only a fresh false→true transition forces it open.
 */
function useDisclosureOpenOnFailure(
  failed: boolean
): readonly [boolean, React.Dispatch<React.SetStateAction<boolean>>] {
  const [open, setOpen] = React.useState(failed);
  const [prevFailed, setPrevFailed] = React.useState(failed);
  if (failed !== prevFailed) {
    setPrevFailed(failed);
    if (failed) {
      setOpen(true);
    }
  }
  return [open, setOpen] as const;
}

const WorkflowStepRow: React.FC<{ step: WorkflowStepView; isLast: boolean }> = (props) => {
  const step = props.step;
  const expandable = step.status === "completed" || step.status === "failed";
  // Surface failures by default (including live failures that arrive after the row mounted while
  // running); otherwise stay collapsed for scanability.
  const [open, setOpen] = useDisclosureOpenOnFailure(step.status === "failed");
  const color = WORKFLOW_TONE_VAR[getWorkflowStepTone(step.status)];
  const showReport = hasDisplayableWorkflowReport(
    step.result?.reportMarkdown,
    step.result?.structuredOutput !== undefined
  );

  return (
    <div className="flex gap-3">
      <div className="relative flex w-[18px] shrink-0 flex-col items-center">
        <span
          className="bg-background z-10 mt-2 grid h-[17px] w-[17px] place-items-center rounded-full border"
          style={{ borderColor: color }}
        >
          <WorkflowStepNode step={step} color={color} />
        </span>
        {!props.isLast && <span className="bg-border w-px flex-1" />}
      </div>
      <div className="min-w-0 flex-1 pt-0.5 pb-2">
        <button
          type="button"
          disabled={!expandable}
          onClick={() => setOpen((value) => !value)}
          className="enabled:hover:bg-surface-secondary flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left disabled:cursor-default"
          aria-expanded={expandable ? open : undefined}
        >
          <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">{step.title}</span>
          {step.status === "completed" && step.durationMs != null && (
            <span className="text-muted shrink-0 text-[11px] tabular-nums">
              {formatWorkflowDuration(step.durationMs)}
            </span>
          )}
          {step.status === "running" && (
            <span className="text-accent shrink-0 text-[11px]">running…</span>
          )}
          {step.status === "failed" && (
            <span className="shrink-0 text-[11px]" style={{ color }}>
              failed
            </span>
          )}
          {expandable &&
            (open ? (
              <ChevronDown className="text-muted h-3 w-3 shrink-0" />
            ) : (
              <ChevronRight className="text-muted h-3 w-3 shrink-0" />
            ))}
        </button>

        {open && expandable && (
          <div className="border-border bg-surface-primary mx-2 mb-1.5 rounded-lg border p-3">
            {step.status === "failed" ? (
              <div className="flex gap-2 text-[12.5px] leading-relaxed" style={{ color }}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{step.error ?? "Sub-agent failed"}</span>
              </div>
            ) : (
              <>
                {step.result?.title != null && step.result.title.length > 0 && (
                  <div className="text-content-primary mb-1.5 text-xs font-semibold">
                    {step.result.title}
                  </div>
                )}
                {showReport && (
                  <div className="text-content-secondary text-[12.5px]">
                    <MarkdownRenderer content={step.result!.reportMarkdown} />
                  </div>
                )}
                {step.result?.structuredOutput !== undefined && (
                  <div className="mt-2.5 flex flex-col gap-1">
                    <div className="text-muted text-[10px] font-semibold tracking-wide uppercase">
                      Structured output
                    </div>
                    <WorkflowJsonBlock
                      value={step.result.structuredOutput}
                      className="max-h-[220px]"
                      ariaLabel={`Structured output for ${step.title}`}
                    />
                  </div>
                )}
                <div className="border-border text-muted mt-2.5 flex flex-wrap gap-3 border-t pt-2 text-[11px] tabular-nums">
                  {step.durationMs != null && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {formatWorkflowDuration(step.durationMs)}
                    </span>
                  )}
                  {step.usage?.tokens != null && (
                    <span className="inline-flex items-center gap-1">
                      <Zap className="h-3 w-3" /> {formatWorkflowTokens(step.usage.tokens)} tok
                    </span>
                  )}
                  {step.usage?.costUsd != null && (
                    <span className="inline-flex items-center gap-1">
                      <Coins className="h-3 w-3" /> {formatWorkflowCost(step.usage.costUsd)}
                    </span>
                  )}
                  {step.taskId != null && <span className="font-mono">task {step.taskId}</span>}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const WorkflowPhaseSection: React.FC<{ phase: WorkflowPhaseView }> = (props) => {
  const phase = props.phase;
  const allDone = phase.total > 0 && phase.done === phase.total;
  // Phase events can carry a structured `details` info object (e.g. {angleCount, maxSources}).
  const detailObject =
    phase.details != null && typeof phase.details === "object" ? phase.details : null;
  const hasInfo = phase.detail != null || detailObject != null;
  // The header collapses the whole phase body (its details + steps) in one click. Collapsed by
  // default to keep a fanned-out run (20+ steps) scannable — except failed phases, which start
  // open so the failure (and the failed step's error) is visible without a manual expand.
  const hasBody = phase.steps.length > 0 || hasInfo;
  const [open, setOpen] = useDisclosureOpenOnFailure(phase.failed);

  const headerContent = (
    <>
      <span className="border-border bg-surface-secondary text-content-secondary grid h-[22px] w-[22px] shrink-0 place-items-center rounded-md border">
        <Layers className="h-3 w-3" />
      </span>
      {phase.label.length > 0 && (
        <span className="text-content-primary text-[13px] font-semibold">{phase.label}</span>
      )}
      {phase.total > 0 && (
        <span className="text-muted text-[11px] tabular-nums">
          {phase.done}/{phase.total}
        </span>
      )}
      {phase.steps.length > 1 && (
        <span
          className="text-ask-mode inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px]"
          style={{ borderColor: ASK_MODE_BORDER }}
        >
          <GitBranch className="h-2.5 w-2.5" /> parallel
        </span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {phase.running ? (
          <WorkflowLiveDot />
        ) : phase.failed ? (
          <AlertTriangle className="h-3 w-3" style={{ color: WORKFLOW_TONE_VAR.destructive }} />
        ) : allDone ? (
          <Check className="text-success h-3 w-3" />
        ) : null}
        {hasBody &&
          (open ? (
            <ChevronDown className="text-muted h-3 w-3" />
          ) : (
            <ChevronRight className="text-muted h-3 w-3" />
          ))}
      </span>
    </>
  );

  return (
    <div>
      {hasBody ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="hover:bg-surface-secondary flex w-full items-center gap-2 rounded-md py-1.5 text-left"
          aria-expanded={open}
        >
          {headerContent}
        </button>
      ) : (
        <div className="flex items-center gap-2 py-1.5">{headerContent}</div>
      )}
      {open && hasInfo && (
        <div className="mb-1.5 ml-[30px] flex flex-col gap-1">
          {phase.detail != null && (
            <div className="text-content-secondary text-[12px]">{phase.detail}</div>
          )}
          {detailObject != null && (
            <WorkflowJsonBlock
              value={detailObject}
              className="max-h-[200px]"
              ariaLabel={`${phase.label} details`}
            />
          )}
        </div>
      )}
      {open && phase.steps.length > 0 && (
        <div className="flex flex-col">
          {phase.steps.map((step, index) => (
            <WorkflowStepRow
              key={step.stepId}
              step={step}
              isLast={index === phase.steps.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const WorkflowFinalReport: React.FC<{ view: WorkflowRunView }> = (props) => {
  // Collapsible (expanded by default) so a long report/structured output can be folded away.
  const [open, setOpen] = React.useState(true);
  const result = props.view.result;
  if (result == null) {
    return null;
  }
  const stats = workflowStructuredOutputEntries(result.structuredOutput);
  const showReport = hasDisplayableWorkflowReport(
    result.reportMarkdown,
    result.structuredOutput !== undefined
  );
  // The full machine-readable result returned to the agent/model. Treat an explicit `null` as
  // present (render it) — only `undefined` means "no structured output", matching the step
  // renderer and chat card; `!= null` would hide a valid null output and leave an empty report.
  const hasStructuredOutput = result.structuredOutput !== undefined;
  return (
    <div
      className="bg-surface-primary flex flex-col gap-2.5 rounded-xl border p-3.5"
      style={{ borderColor: "color-mix(in srgb, var(--color-success) 30%, var(--color-border))" }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="text-muted flex w-full items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase"
        aria-expanded={open}
      >
        <FileText className="h-3 w-3" /> Final report
        <span className="ml-auto">
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
      </button>
      {open && (
        <>
          {showReport && (
            <div className="text-content-secondary text-[12.5px]">
              <MarkdownRenderer content={result.reportMarkdown} />
            </div>
          )}
          {stats.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {stats.map((stat) => (
                <span
                  key={stat.key}
                  className="border-border bg-surface-secondary text-muted rounded-md border px-2 py-0.5 text-[11px] tabular-nums"
                >
                  <b className="text-content-primary font-semibold">{stat.value}</b> {stat.key}
                </span>
              ))}
            </div>
          )}
          {hasStructuredOutput && (
            <div className="flex flex-col gap-1">
              <div className="text-muted text-[10px] font-semibold tracking-wide uppercase">
                Structured output
              </div>
              <WorkflowJsonBlock
                value={result.structuredOutput}
                className="max-h-[280px]"
                ariaLabel="Workflow structured output"
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};

/** "Timeline" run body: a vertical stream of phases and their agent steps. */
export const WorkflowTimeline: React.FC<{ view: WorkflowRunView }> = (props) => {
  const view = props.view;
  return (
    <div className="flex flex-col gap-4">
      {/* Surface a run-level failure (e.g. setup/compile/eval errors that occur before any step)
          so a failed run never shows just "No steps yet" with no reason. */}
      {view.errorMessage != null && view.status === "failed" && (
        <div
          className="flex gap-2 rounded-lg border p-3 text-[12.5px] leading-relaxed"
          style={{
            color: WORKFLOW_TONE_VAR.destructive,
            borderColor: "color-mix(in srgb, var(--color-danger) 35%, transparent)",
            background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
          }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{view.errorMessage}</span>
        </div>
      )}
      <WorkflowFinalReport view={view} />
      <div className="flex flex-col gap-1">
        <div className="text-muted flex items-center gap-1.5 text-[11px] font-semibold tracking-wide uppercase">
          <ListTree className="h-3 w-3" /> Step stream
        </div>
        {view.phases.length === 0 ? (
          <div className="text-muted px-2 py-3 text-xs">No steps yet.</div>
        ) : (
          view.phases.map((phase) => (
            <WorkflowPhaseSection key={phase.name || "__ungrouped"} phase={phase} />
          ))
        )}
      </div>
    </div>
  );
};
