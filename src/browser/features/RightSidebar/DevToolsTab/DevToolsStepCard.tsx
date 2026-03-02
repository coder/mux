import { useState } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import { cn } from "@/common/lib/utils";
import type { DevToolsStep } from "@/common/types/devtools";
import { assertNever } from "@/common/utils/assertNever";

type StepSubTab = "input" | "output" | "raw";

const STEP_SUB_TABS: readonly StepSubTab[] = ["input", "output", "raw"];
const PRE_CLASS_NAME =
  "whitespace-pre-wrap break-all text-[10px] text-muted bg-background-primary rounded p-2 mt-1 max-h-[200px] overflow-auto";

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
          <span className="text-muted text-[10px]">{props.step.durationMs}ms</span>
        )}
        {props.step.usage?.totalTokens != null && (
          <span className="text-muted text-[10px]">{props.step.usage.totalTokens}tok</span>
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

  if (Array.isArray(prompt)) {
    if (prompt.length === 0) {
      return <p className="text-muted text-[10px]">No prompt messages</p>;
    }

    return (
      <div className="flex flex-col gap-1">
        {prompt.map((promptPart, index) => (
          <div
            key={`${props.step.id}-prompt-${index}`}
            className="border-border-light rounded border p-1.5"
          >
            <p className="text-foreground text-[10px] font-semibold">{getPromptRole(promptPart)}</p>
            <pre className={PRE_CLASS_NAME}>
              {stringifyForDisplay(getPromptContent(promptPart))}
            </pre>
          </div>
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

      {reasoningParts.length > 0 && (
        <div>
          <p className="text-foreground text-[10px] font-medium">Reasoning:</p>
          {reasoningParts.map((reasoningPart) => (
            <pre key={reasoningPart.id} className={PRE_CLASS_NAME}>
              {reasoningPart.text}
            </pre>
          ))}
        </div>
      )}

      {toolCalls.length > 0 && (
        <div>
          <p className="text-foreground text-[10px] font-medium">Tool calls</p>
          <pre className={PRE_CLASS_NAME}>{stringifyForDisplay(toolCalls)}</pre>
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
      <div>
        <div className="text-muted mb-1 text-xs font-medium">Request</div>
        <pre className="bg-background-secondary max-h-64 overflow-auto rounded p-2 text-xs">
          {props.step.rawRequest != null
            ? stringifyForDisplay(props.step.rawRequest)
            : "No request body captured"}
        </pre>
      </div>

      <div>
        <div className="text-muted mb-1 text-xs font-medium">Response</div>
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

function formatSubTabLabel(subTab: StepSubTab): string {
  if (subTab === "input") return "Input";
  if (subTab === "output") return "Output";
  if (subTab === "raw") return "Raw";
  return assertNever(subTab);
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
