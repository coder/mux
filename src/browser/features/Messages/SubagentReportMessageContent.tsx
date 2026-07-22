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

const STRUCTURED_OUTPUT_START = "\n<structured_output_json>\n";
const STRUCTURED_OUTPUT_END = "\n</structured_output_json>";
const REPORT_END = "\n</report_markdown>";

function splitStructuredOutput(envelope: string): {
  reportEnvelope: string;
  structuredOutput: string | null;
} {
  if (!envelope.endsWith(STRUCTURED_OUTPUT_END)) {
    return { reportEnvelope: envelope, structuredOutput: null };
  }

  const start = envelope.lastIndexOf(STRUCTURED_OUTPUT_START);
  if (start === -1) {
    return { reportEnvelope: envelope, structuredOutput: null };
  }

  return {
    reportEnvelope: envelope.slice(0, start),
    structuredOutput: envelope
      .slice(start + STRUCTURED_OUTPUT_START.length, -STRUCTURED_OUTPUT_END.length)
      .trim(),
  };
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

  const { reportEnvelope, structuredOutput } = splitStructuredOutput(root[1]);
  if (!reportEnvelope.endsWith(REPORT_END)) return null;

  // Parse from the fixed metadata prefix, then anchor the report close at the end. Report markdown
  // is intentionally unescaped by TaskService, so it may itself contain protocol-looking examples
  // such as a line containing </report_markdown>; only the final delimiter terminates the field.
  const fields =
    /^<task_id>([^\n]*)<\/task_id>\n<agent_type>([^\n]*)<\/agent_type>\n(?:<status>([^\n]*)<\/status>\n)?<title>([\s\S]*?)<\/title>\n<report_markdown>\n([\s\S]*)$/.exec(
      reportEnvelope.slice(0, -REPORT_END.length)
    );
  if (!fields) return null;

  const taskId = fields[1]?.trim();
  const agentType = fields[2]?.trim();
  const rawStatus = fields[3]?.trim() || null;
  const title = fields[4]?.replace(/\s+/g, " ").trim();
  const reportMarkdown = fields[5];

  // TaskService stores reportMarkdown verbatim between separator newlines. Preserve leading
  // indentation and trailing spaces because Markdown uses both for code blocks and hard breaks.
  if (!taskId || !agentType || !title || reportMarkdown == null || reportMarkdown.length === 0) {
    return null;
  }
  if (rawStatus !== null && rawStatus !== "in_progress" && rawStatus !== "completed") return null;

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
