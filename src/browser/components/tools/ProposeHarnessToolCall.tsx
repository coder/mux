import React, { useEffect, useRef, useState } from "react";
import { ClipboardCheck, ClipboardList, Play } from "lucide-react";

import type { ProposeHarnessToolError, ProposeHarnessToolResult } from "@/common/types/tools";
import type { WorkspaceHarnessConfig } from "@/common/types/harness";
import { useAPI } from "@/browser/contexts/API";
import { usePopoverError } from "@/browser/hooks/usePopoverError";
import { getAgentIdKey } from "@/common/constants/storage";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { cn } from "@/common/lib/utils";

import {
  ExpandIcon,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolName,
} from "./shared/ToolPrimitives";
import { getStatusDisplay, type ToolStatus, useToolExpansion } from "./shared/toolUtils";
import { PopoverError } from "../PopoverError";
import { IconActionButton, type ButtonConfig } from "../Messages/MessageWindow";

interface HarnessGetData {
  config: WorkspaceHarnessConfig;
  paths: { configPath: string; progressPath: string };
  exists: boolean;
}

function isProposeHarnessResult(result: unknown): result is ProposeHarnessToolResult {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === true &&
    "harnessPath" in result
  );
}

function isProposeHarnessError(result: unknown): result is ProposeHarnessToolError {
  return (
    result !== null &&
    typeof result === "object" &&
    "success" in result &&
    result.success === false &&
    "error" in result
  );
}

function formatChecklistStatus(status: string): string {
  if (status === "done") return "[x]";
  if (status === "doing") return "[~]";
  if (status === "blocked") return "[!]";
  return "[ ]";
}

interface ProposeHarnessToolCallProps {
  args: unknown;
  result: unknown;
  status: ToolStatus;
  workspaceId?: string;
  className?: string;
  /** Whether this is the latest propose_harness tool call (for external edit detection) */
  isLatest?: boolean;
}

export const ProposeHarnessToolCall: React.FC<ProposeHarnessToolCallProps> = (props) => {
  const { result, status, workspaceId, className, isLatest } = props;
  const { expanded, toggleExpanded } = useToolExpansion(true);
  const { api } = useAPI();
  const loopError = usePopoverError();

  const [data, setData] = useState<HarnessGetData | null>(null);

  const [isStartingLoop, setIsStartingLoop] = useState(false);
  const isStartingLoopRef = useRef(false);

  const startButtonRef = useRef<HTMLDivElement>(null);

  // Fetch fresh harness config for the latest propose_harness.
  useEffect(() => {
    if (!isLatest || !workspaceId || !api || status !== "completed") {
      return;
    }

    const fetchHarness = async () => {
      try {
        const res = await api.workspace.harness.get({ workspaceId });
        if (!res.success) {
          return;
        }
        setData(res.data);
      } catch {
        // Best-effort only.
      }
    };

    void fetchHarness();

    const handleFocus = () => void fetchHarness();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [api, isLatest, status, workspaceId]);

  let harnessPath: string | undefined;
  let errorMessage: string | undefined;

  if (isProposeHarnessResult(result)) {
    harnessPath = result.harnessPath;
  }

  if (isProposeHarnessError(result)) {
    errorMessage = result.error;
  }

  const statusDisplay = getStatusDisplay(status);

  const handleApproveAndStart = () => {
    if (!workspaceId || !api) return;
    if (isStartingLoopRef.current) return;

    // Capture positioning from the ref for error popover placement
    const anchorPosition = startButtonRef.current
      ? (() => {
          const { bottom, left } = startButtonRef.current.getBoundingClientRect();
          return { top: bottom + 8, left };
        })()
      : { top: 100, left: 100 };

    isStartingLoopRef.current = true;
    setIsStartingLoop(true);

    // Switch to exec so the loop runner uses Exec mode settings.
    updatePersistedState(getAgentIdKey(workspaceId), "exec");

    api.workspace.loop
      .start({ workspaceId })
      .then((res) => {
        if (!res.success) {
          loopError.showError("approve-harness", res.error, anchorPosition);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        loopError.showError("approve-harness", message, anchorPosition);
      })
      .finally(() => {
        isStartingLoopRef.current = false;
        setIsStartingLoop(false);
      });
  };

  const actionButtons: ButtonConfig[] = [];

  if (workspaceId && status === "completed" && !errorMessage) {
    actionButtons.push({
      label: "Approve & Start Ralph loop",
      component: (
        <div ref={startButtonRef}>
          <IconActionButton
            button={{
              label: "Approve & Start Ralph loop",
              onClick: handleApproveAndStart,
              disabled: !api || isStartingLoop,
              icon: <Play className={cn(isStartingLoop && "animate-pulse")} />,
              tooltip: "Switch to Exec and start the Ralph loop with this harness",
            }}
          />
        </div>
      ),
    });
  }

  const showChecklist = data?.config.checklist && data.config.checklist.length > 0;
  const showGates = data?.config.gates && data.config.gates.length > 0;

  const body = (
    <div className={cn("plan-surface rounded-md p-3 shadow-md", className)}>
      <div className="plan-divider mb-3 flex items-center gap-2 border-b pb-2">
        <ClipboardList aria-hidden="true" className="h-4 w-4" />
        <div className="text-harness-init-mode font-mono text-[13px] font-semibold">
          Harness proposal
        </div>
      </div>

      {errorMessage ? (
        <div className="text-error rounded-sm p-2 font-mono text-xs">{errorMessage}</div>
      ) : status !== "completed" ? (
        <div className="border-border-light text-muted rounded-sm border border-dashed p-3 font-mono text-xs">
          Validating harness…
        </div>
      ) : data ? (
        <div className="space-y-3">
          <div className="border-border-light rounded border p-3">
            <div className="text-secondary text-xs">Files</div>
            <div className="mt-1 font-mono text-xs">
              <div>{data.paths.configPath}</div>
              <div>{data.paths.progressPath}</div>
            </div>
          </div>

          {showChecklist && (
            <div className="border-border-light rounded border p-3">
              <div className="text-secondary text-xs">Checklist</div>
              <div className="mt-2 space-y-1 font-mono text-xs">
                {data.config.checklist.map((item) => (
                  <div key={item.id}>
                    {formatChecklistStatus(item.status)} {item.title}
                  </div>
                ))}
              </div>
            </div>
          )}

          {showGates && (
            <div className="border-border-light rounded border p-3">
              <div className="text-secondary text-xs">Gates</div>
              <div className="mt-2 space-y-1 font-mono text-xs">
                {data.config.gates.map((gate, index) => (
                  <div key={gate.id ?? `${gate.command}-${index}`}>- {gate.command}</div>
                ))}
              </div>
            </div>
          )}

          {!showChecklist && !showGates && (
            <div className="border-border-light text-secondary rounded border border-dashed p-3 text-xs">
              Harness is empty. Edit the harness config and call propose_harness again.
            </div>
          )}
        </div>
      ) : (
        <div className="border-border-light rounded border p-3">
          <div className="text-secondary text-xs">Files</div>
          <div className="mt-1 font-mono text-xs">
            <div>{harnessPath ?? "(unknown harness path)"}</div>
          </div>
        </div>
      )}

      {actionButtons.length > 0 && (
        <div className="mt-3 flex items-center gap-0.5">
          {actionButtons.map((button, index) => (
            <IconActionButton key={index} button={button} />
          ))}
          <div className="text-muted ml-1 inline-flex items-center gap-1 text-[11px]">
            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Review, then approve to start the loop.
          </div>
        </div>
      )}
    </div>
  );

  return (
    <>
      <ToolContainer expanded={expanded}>
        <ToolHeader onClick={toggleExpanded}>
          <ExpandIcon expanded={expanded}>▶</ExpandIcon>
          <ToolName>propose_harness</ToolName>
          <StatusIndicator status={status}>{statusDisplay}</StatusIndicator>
        </ToolHeader>

        {expanded && <ToolDetails>{body}</ToolDetails>}
      </ToolContainer>
      <PopoverError error={loopError.error} prefix="Failed to start Ralph loop" />
    </>
  );
};
