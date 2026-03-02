import { useState } from "react";
import { AlertCircle, Brain, ChevronRight, Wrench } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { DevToolsStep } from "@/common/types/devtools";
import { formatDuration } from "@/common/utils/formatDuration";
import { assertNever } from "@/common/utils/assertNever";

type StepSubTab = "input" | "output" | "raw";

const STEP_SUB_TABS: readonly StepSubTab[] = ["input", "output", "raw"];
const PRE_CLASS_NAME =
  "whitespace-pre-wrap break-all text-[10px] text-muted bg-background-primary rounded p-2 mt-1 max-h-[200px] overflow-auto";
const ROLE_COLORS: Record<string, string> = {
  system: "bg-neutral-500/20 text-neutral-400",
  user: "bg-blue-500/20 text-blue-400",
  assistant: "bg-green-500/20 text-green-400",
  tool: "bg-violet-500/20 text-violet-400",
};
const DEFAULT_ROLE_COLOR = "bg-neutral-500/20 text-neutral-400";

interface DevToolsStepCardProps {
  step: DevToolsStep;
}

export function DevToolsStepCard(props: DevToolsStepCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<StepSubTab>("input");

  return (
    <div className="border-border-light bg-background rounded border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover flex w-full items-center gap-1.5 px-2 py-1 text-left"
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
        <span className="text-foreground text-xs font-medium">Step {props.step.stepNumber}</span>
        <span className="text-muted text-[10px]">{props.step.modelId}</span>
        {props.step.durationMs != null && (
          <span className="text-muted text-[10px]">
            {formatDuration(props.step.durationMs, "precise")}
          </span>
        )}
        {props.step.usage != null &&
          (props.step.usage.inputTokens != null || props.step.usage.outputTokens != null) && (
            <span className="text-muted text-[10px]">
              {props.step.usage.inputTokens ?? "?"}→{props.step.usage.outputTokens ?? "?"} tok
            </span>
          )}
        {props.step.error && <AlertCircle className="text-destructive ml-auto h-3 w-3 shrink-0" />}
      </button>

      {expanded && (
        <div className="border-border-light border-t px-2 py-1.5">
          <div className="flex items-center gap-1">
            {STEP_SUB_TABS.map((subTab) => (
              <button
                key={subTab}
                type="button"
                className={cn(
                  "px-1.5 py-0.5 text-[10px] rounded",
                  activeSubTab === subTab
                    ? "bg-hover text-foreground"
                    : "text-muted hover:text-foreground"
                )}
                onClick={() => setActiveSubTab(subTab)}
              >
                {formatSubTabLabel(subTab)}
              </button>
            ))}
          </div>

          <div className="mt-1">
            <StepSubTabContent activeSubTab={activeSubTab} step={props.step} />
          </div>
        </div>
      )}
    </div>
  );
}

function StepSubTabContent(props: { activeSubTab: StepSubTab; step: DevToolsStep }) {
  switch (props.activeSubTab) {
    case "input":
      return <StepInputView step={props.step} />;
    case "output":
      return <StepOutputView step={props.step} />;
    case "raw":
      return <StepRawView step={props.step} />;
    default:
      return assertNever(props.activeSubTab);
  }
}

function StepInputView(props: { step: DevToolsStep }) {
  const prompt = props.step.input?.prompt;

  if (isUnknownArray(prompt)) {
    if (prompt.length === 0) {
      return <p className="text-muted text-[10px]">No prompt messages</p>;
    }

    return (
      <div className="flex flex-col gap-1">
        {prompt.map((promptPart, index) => (
          <MessageBubble key={`${props.step.id}-prompt-${index}`} message={promptPart} />
        ))}
      </div>
    );
  }

  return <pre className={PRE_CLASS_NAME}>{stringifyForDisplay(props.step.input)}</pre>;
}

function StepOutputView(props: { step: DevToolsStep }) {
  const textParts = props.step.output?.textParts ?? [];
  const reasoningParts = props.step.output?.reasoningParts ?? [];
  const toolCalls = props.step.output?.toolCalls ?? [];
  const finishReason = props.step.output?.finishReason;

  const hasOutput =
    textParts.length > 0 ||
    reasoningParts.length > 0 ||
    toolCalls.length > 0 ||
    Boolean(finishReason) ||
    Boolean(props.step.error);

  if (!hasOutput) {
    return <p className="text-muted text-[10px]">No output recorded</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      {textParts.map((textPart) => (
        <div key={textPart.id}>
          <p className="text-foreground text-[10px] font-medium">Text</p>
          <pre className={PRE_CLASS_NAME}>{textPart.text}</pre>
        </div>
      ))}

      {reasoningParts.map((reasoningPart) => (
        <ReasoningBlock key={reasoningPart.id} text={reasoningPart.text} />
      ))}

      {toolCalls.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-foreground text-[10px] font-medium">Tool calls ({toolCalls.length})</p>
          {toolCalls.map((toolCall, index) => {
            const toolCallId =
              isRecord(toolCall) && typeof toolCall.toolCallId === "string"
                ? toolCall.toolCallId
                : null;
            return (
              <ToolCallCard
                key={toolCallId ?? `${props.step.id}-tool-${index}`}
                toolCall={toolCall}
              />
            );
          })}
        </div>
      )}

      {finishReason && <p className="text-muted text-[10px]">Finish reason: {finishReason}</p>}

      {props.step.error && (
        <p className="text-destructive text-[10px] break-all">Error: {props.step.error}</p>
      )}
    </div>
  );
}

function StepRawView(props: { step: DevToolsStep }) {
  return (
    <div className="space-y-3">
      {props.step.requestHeaders != null && Object.keys(props.step.requestHeaders).length > 0 && (
        <div>
          <div className="text-muted mb-1 text-xs font-medium">Request Headers</div>
          <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
            {JSON.stringify(props.step.requestHeaders, null, 2)}
          </pre>
        </div>
      )}

      <div>
        <div className="text-muted mb-1 text-xs font-medium">Request Body</div>
        <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
          {props.step.rawRequest != null
            ? stringifyForDisplay(props.step.rawRequest)
            : "No request body captured"}
        </pre>
      </div>

      {props.step.responseHeaders != null && Object.keys(props.step.responseHeaders).length > 0 && (
        <div>
          <div className="text-muted mb-1 text-xs font-medium">Response Headers</div>
          <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
            {JSON.stringify(props.step.responseHeaders, null, 2)}
          </pre>
        </div>
      )}

      <div>
        <div className="text-muted mb-1 text-xs font-medium">Response Body</div>
        <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
          {props.step.rawResponse != null
            ? stringifyForDisplay(props.step.rawResponse)
            : "No response body captured"}
        </pre>
      </div>

      {props.step.rawChunks != null && (
        <div>
          <div className="text-muted mb-1 text-xs font-medium">Provider Chunks (SSE)</div>
          <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
            {stringifyForDisplay(props.step.rawChunks)}
          </pre>
        </div>
      )}
    </div>
  );
}

function ToolCallCard(props: { toolCall: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const toolCallRecord = isRecord(props.toolCall) ? props.toolCall : null;
  const toolName =
    typeof toolCallRecord?.toolName === "string" && toolCallRecord.toolName.length > 0
      ? toolCallRecord.toolName
      : "unknown";
  const args = toolCallRecord?.args;
  const argsPreview = formatArgsPreview(args);

  return (
    <div className="bg-background-primary rounded border-l-2 border-violet-500/40 px-2 py-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover/50 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left"
      >
        <Wrench className="h-3 w-3 shrink-0 text-violet-500" />
        <span className="text-foreground text-[10px] font-semibold">{toolName}</span>
        {!expanded && argsPreview && (
          <span className="text-muted truncate text-[10px]">{argsPreview}</span>
        )}
        <ChevronRight
          className={cn(
            "text-muted ml-auto h-2.5 w-2.5 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded && args != null && (
        <pre className="text-muted mt-1 max-h-[150px] overflow-auto text-[10px] break-all whitespace-pre-wrap">
          {stringifyForDisplay(args)}
        </pre>
      )}
    </div>
  );
}

function MessageBubble(props: { message: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const role = getPromptRole(props.message);
  const content = extractDisplayContent(getPromptContent(props.message));
  const isTruncated = content.length > 500;
  const displayContent = !expanded && isTruncated ? `${content.slice(0, 500)}…` : content;

  return (
    <div className="border-border-light overflow-hidden rounded border">
      <div className="bg-hover/50 px-2 py-1">
        <RoleBadge role={role} />
      </div>
      <pre className="text-muted max-h-[200px] overflow-auto p-2 text-[10px] break-words whitespace-pre-wrap">
        {displayContent}
      </pre>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="px-2 pb-1 text-[10px] text-blue-400 hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function RoleBadge(props: { role: string }) {
  const normalizedRole = props.role.toLowerCase();
  const colorClass = ROLE_COLORS[normalizedRole] ?? DEFAULT_ROLE_COLOR;

  return (
    <span className={cn("rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase", colorClass)}>
      {normalizedRole}
    </span>
  );
}

function ReasoningBlock(props: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLongText = props.text.length > 150;
  const preview = isLongText ? `${props.text.slice(0, 150)}…` : props.text;

  return (
    <div className="bg-background-primary rounded border-l-2 border-amber-500/40 px-2 py-1">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="hover:bg-hover/50 flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left"
      >
        <Brain className="h-3 w-3 shrink-0 text-amber-500" />
        <span className="text-foreground text-[10px] font-medium">Thinking</span>
        <ChevronRight
          className={cn(
            "text-muted ml-auto h-2.5 w-2.5 shrink-0 transition-transform",
            expanded && "rotate-90"
          )}
        />
      </button>
      <pre className="text-muted mt-1 max-h-[200px] overflow-auto text-[10px] break-words whitespace-pre-wrap">
        {expanded ? props.text : preview}
      </pre>
    </div>
  );
}

function formatSubTabLabel(subTab: StepSubTab): string {
  if (subTab === "input") return "Input";
  if (subTab === "output") return "Output";
  if (subTab === "raw") return "Raw";
  return assertNever(subTab);
}

function formatArgsPreview(args: unknown): string {
  if (!isRecord(args)) {
    const value = formatPreviewValue(args);
    return value.length > 80 ? `${value.slice(0, 80)}…` : value;
  }

  const entries = Object.entries(args);
  if (entries.length === 0) {
    return "{}";
  }

  const previewParts = entries.slice(0, 3).map(([key, value]) => {
    const previewValue = formatPreviewValue(value);
    const truncatedValue =
      previewValue.length > 30 ? `${previewValue.slice(0, 30)}…` : previewValue;
    return `${key}: ${truncatedValue}`;
  });

  if (entries.length > 3) {
    previewParts.push("…");
  }

  return previewParts.join(", ");
}

function formatPreviewValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value == null) {
    return String(value);
  }

  return stringifyForDisplay(value).replace(/\s+/g, " ").trim();
}

function extractDisplayContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts: string[] = [];

    for (const part of content) {
      const displayPart = extractDisplayContentPart(part);
      if (displayPart != null && displayPart.length > 0) {
        textParts.push(displayPart);
      }
    }

    return textParts.join("\n");
  }

  const singlePartDisplay = extractDisplayContentPart(content);
  if (singlePartDisplay != null && singlePartDisplay.length > 0) {
    return singlePartDisplay;
  }

  return stringifyForDisplay(content);
}

function extractDisplayContentPart(part: unknown): string | null {
  if (typeof part === "string") {
    return part;
  }

  if (!isRecord(part)) {
    return stringifyForDisplay(part);
  }

  if (isProviderOptionsOnlyContentPart(part)) {
    return null;
  }

  if (part.type === "text" && typeof part.text === "string") {
    return part.text;
  }

  if (part.type === "reasoning" && typeof part.text === "string") {
    return `[Thinking] ${part.text}`;
  }

  if (part.type === "tool-result" && typeof part.toolName === "string") {
    const output = extractToolResultOutput(part.output);
    return `[Tool Result: ${part.toolName}]\n${stringifyForDisplay(output)}`;
  }

  if (typeof part.type === "string") {
    return `[${part.type}]`;
  }

  return stringifyForDisplay(part);
}

function isProviderOptionsOnlyContentPart(part: Record<string, unknown>): boolean {
  return Object.keys(part).every((key) => key === "providerOptions") && "providerOptions" in part;
}

function extractToolResultOutput(output: unknown): unknown {
  if (isRecord(output) && output.type === "json" && "value" in output) {
    return output.value;
  }

  return output;
}

function stringifyForDisplay(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (value === undefined) {
    return "undefined";
  }

  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? "null";
  } catch (error) {
    return error instanceof Error
      ? `Unable to format value: ${error.message}`
      : "Unable to format value";
  }
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPromptRole(value: unknown): string {
  if (!isRecord(value)) {
    return "unknown";
  }

  const role = value.role;
  return typeof role === "string" ? role : "unknown";
}

function getPromptContent(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  if (!("content" in value)) {
    return value;
  }

  return value.content;
}
