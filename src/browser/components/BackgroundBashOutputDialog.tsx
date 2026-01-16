import React, { useEffect, useState } from "react";
import { CopyButton } from "./ui/CopyButton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { DetailContent } from "./tools/shared/ToolPrimitives";
import { useAPI } from "@/browser/contexts/API";
import {
  appendLiveBashOutputChunk,
  type LiveBashOutputInternal,
} from "@/browser/utils/messages/liveBashOutputBuffer";
import { BASH_TRUNCATE_MAX_TOTAL_BYTES } from "@/common/constants/toolLimits";

const BACKGROUND_BASH_INITIAL_TAIL_BYTES = 64_000;
const BACKGROUND_BASH_POLL_INTERVAL_MS = 500;

interface BackgroundBashOutputDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  processId: string;
  displayName?: string;
}

export const BackgroundBashOutputDialog: React.FC<BackgroundBashOutputDialogProps> = (props) => (
  <Dialog open={props.open} onOpenChange={props.onOpenChange}>
    <DialogContent className="max-h-[80vh] max-w-4xl overflow-hidden">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="font-mono text-sm">{props.displayName ?? props.processId}</span>
          {props.displayName && (
            <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
              {props.processId}
            </code>
          )}
        </DialogTitle>
      </DialogHeader>

      <BackgroundBashOutputViewer workspaceId={props.workspaceId} processId={props.processId} />
    </DialogContent>
  </Dialog>
);

const BackgroundBashOutputViewer: React.FC<{ workspaceId: string; processId: string }> = (
  props
) => {
  const { api } = useAPI();

  const [output, setOutput] = useState<LiveBashOutputInternal | undefined>(undefined);
  const [status, setStatus] = useState<"running" | "exited" | "killed" | "failed">("running");
  const [truncatedStart, setTruncatedStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    setOutput(undefined);
    setStatus("running");
    setTruncatedStart(false);
    setError(null);
    setIsLoading(true);

    if (!api) {
      setIsLoading(false);
      setError("API unavailable");
      return;
    }

    let cancelled = false;

    const run = async () => {
      let offset: number | undefined = undefined;

      while (!cancelled) {
        const result = await api.workspace.backgroundBashes.getOutput(
          offset === undefined
            ? {
                workspaceId: props.workspaceId,
                processId: props.processId,
                tailBytes: BACKGROUND_BASH_INITIAL_TAIL_BYTES,
              }
            : {
                workspaceId: props.workspaceId,
                processId: props.processId,
                fromOffset: offset,
              }
        );

        if (cancelled) return;

        setIsLoading(false);

        if (!result.success) {
          setError(result.error);
          return;
        }

        setStatus(result.data.status);
        if (result.data.truncatedStart) {
          setTruncatedStart(true);
        }

        offset = result.data.nextOffset;

        if (result.data.output.length > 0) {
          setOutput((prev) =>
            appendLiveBashOutputChunk(
              prev,
              { text: result.data.output, isError: false },
              BASH_TRUNCATE_MAX_TOTAL_BYTES
            )
          );
        }

        if (result.data.status !== "running") {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, BACKGROUND_BASH_POLL_INTERVAL_MS));
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [api, props.processId, props.workspaceId]);

  const text = output?.combined ?? "";
  const isTruncatedToMaxBytes = output?.truncated ?? false;

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="text-muted font-mono text-[11px]">status: {status}</div>
        <CopyButton text={text} className="h-6" />
      </div>

      {truncatedStart && (
        <div className="text-muted text-[10px] italic">
          Showing last {Math.round(BACKGROUND_BASH_INITIAL_TAIL_BYTES / 1000)}KB
        </div>
      )}

      {isTruncatedToMaxBytes && (
        <div className="text-muted text-[10px] italic">Output truncated (showing last ~1MB)</div>
      )}

      {error && <div className="text-error text-[11px]">{error}</div>}

      <DetailContent className="max-h-[60vh] min-h-[200px] px-2 py-1.5">
        {isLoading ? "Loading…" : text.length > 0 ? text : error ? "" : "No output yet"}
      </DetailContent>
    </div>
  );
};
