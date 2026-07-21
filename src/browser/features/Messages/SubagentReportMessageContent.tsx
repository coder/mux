import { useState, type ReactElement } from "react";
import { Bot, Braces, ChevronRight, CircleCheck, Radio } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { MarkdownRenderer } from "./MarkdownRenderer";

export interface SubagentReportEnvelope {
  taskId: string;
  agentType: string;
  status: "in_progress" | "completed";
  title: string;
  reportMarkdown: string;
  structuredOutputJson?: string;
}

function extractLine(envelope: string, tag: string): string | null {
  const match = new RegExp(`^<${tag}>([^\\n]*)<\\/${tag}>$`, "m").exec(envelope);
  const value = match?.[1]?.trim();
  if (!value) return null;
  return value;
}

function extractBlock(envelope: string, tag: string): string | null {
  const match = new RegExp(`(?:^|\\n)<${tag}>\\n([\\s\\S]*?)\\n<\\/${tag}>(?:\\n|$)`).exec(
    envelope
  );
  return match?.[1]?.trim() ?? null;
}

function normalizeStructuredOutput(block: string): string {
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/.exec(block.trim());
  const json = fenced?.[1]?.trim() ?? block.trim();

  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    // Preserve malformed or forward-compatible payloads instead of hiding report data.
    return json;
  }
}

/**
 * Parse only the exact synthetic protocol envelope emitted by TaskService. Returning null keeps
 * malformed or user-authored lookalikes on the normal escaped user-message rendering path.
 */
export function parseSubagentReportEnvelope(content: string): SubagentReportEnvelope | null {
  const root = /^<mux_subagent_report>\n([\s\S]*?)\n<\/mux_subagent_report>$/.exec(content);
  if (!root) return null;

  const envelope = root[1];
  const taskId = extractLine(envelope, "task_id");
  const agentType = extractLine(envelope, "agent_type");
  const title = extractLine(envelope, "title");
  const reportMarkdown = extractBlock(envelope, "report_markdown");
  const rawStatus = extractLine(envelope, "status");

  if (!taskId || !agentType || !title || !reportMarkdown) return null;
  if (rawStatus !== null && rawStatus !== "in_progress" && rawStatus !== "completed") return null;

  const structuredOutput = extractBlock(envelope, "structured_output_json");
  return {
    taskId,
    agentType,
    // Reports persisted before incremental updates existed had no explicit status.
    status: rawStatus ?? "completed",
    title,
    reportMarkdown,
    ...(structuredOutput
      ? { structuredOutputJson: normalizeStructuredOutput(structuredOutput) }
      : {}),
  };
}

interface SubagentReportMessageContentProps {
  report: SubagentReportEnvelope;
}

/**
 * Present trusted sub-agent findings as transcript content rather than exposing the model-facing
 * XML protocol. The existing user bubble owns the border and surface, avoiding nested card chrome.
 */
export function SubagentReportMessageContent(
  props: SubagentReportMessageContentProps
): ReactElement {
  const [structuredOutputExpanded, setStructuredOutputExpanded] = useState(false);
  const isInProgress = props.report.status === "in_progress";
  const StatusIcon = isInProgress ? Radio : CircleCheck;
  const statusLabel = isInProgress ? "In progress" : "Completed";

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-start gap-2.5">
        <Bot aria-hidden="true" className="text-muted mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm leading-snug font-medium text-[var(--color-user-text)]">
            {props.report.title}
          </div>
          <div className="text-muted mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-snug">
            <span className="truncate">{props.report.agentType}</span>
            <span aria-hidden="true">·</span>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1",
                isInProgress ? "text-backgrounded" : "text-success"
              )}
            >
              <StatusIcon aria-hidden="true" className="size-3" />
              {statusLabel}
            </span>
          </div>
        </div>
      </div>

      <MarkdownRenderer
        content={props.report.reportMarkdown}
        className="mt-2 text-sm leading-relaxed text-[var(--color-user-text)]"
      />

      {props.report.structuredOutputJson && (
        <div className="mt-2 border-t border-[var(--color-user-border)] pt-2">
          <button
            type="button"
            aria-expanded={structuredOutputExpanded}
            onClick={() => setStructuredOutputExpanded((previous) => !previous)}
            className="text-muted hover:text-foreground flex cursor-pointer items-center gap-1.5 text-xs"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform duration-200",
                structuredOutputExpanded && "rotate-90"
              )}
            />
            <Braces aria-hidden="true" className="size-3" />
            Structured output
          </button>
          {structuredOutputExpanded && (
            <pre className="bg-code-bg mt-2 max-h-[40vh] max-w-full overflow-auto rounded-sm p-2 font-mono text-xs leading-relaxed whitespace-pre text-[var(--color-user-text)]">
              {props.report.structuredOutputJson}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
