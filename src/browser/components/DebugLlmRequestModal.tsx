import React, { useCallback, useEffect, useState } from "react";
import type { DebugLlmRequestSnapshot } from "@/common/types/debugLlmRequest";
import { useAPI } from "@/browser/contexts/API";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { copyToClipboard } from "@/browser/utils/clipboard";

interface DebugLlmRequestModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const DebugLlmRequestModal: React.FC<DebugLlmRequestModalProps> = ({
  workspaceId,
  open,
  onOpenChange,
}) => {
  const { api } = useAPI();
  const { copied, copyToClipboard: copy } = useCopyToClipboard(copyToClipboard);

  const [snapshot, setSnapshot] = useState<DebugLlmRequestSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSnapshot = useCallback(async () => {
    if (!api) return;

    setLoading(true);
    setError(null);

    try {
      const result = await api.workspace.getLastLlmRequest({ workspaceId });
      if (!result.success) {
        setError(result.error);
        setSnapshot(null);
        return;
      }

      setSnapshot(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  }, [api, workspaceId]);

  useEffect(() => {
    if (!open || !api) return;
    void fetchSnapshot();
  }, [open, api, fetchSnapshot]);

  const json = snapshot ? JSON.stringify(snapshot, null, 2) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent maxWidth="900px">
        <DialogHeader>
          <DialogTitle>Last LLM request (debug)</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => void fetchSnapshot()}
            disabled={!api || loading}
          >
            {loading ? "Loading..." : "Refresh"}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void copy(json)}
            disabled={!snapshot || loading}
          >
            {copied ? "Copied" : "Copy JSON"}
          </Button>
        </div>

        {error && <div className="text-danger-soft text-sm">{error}</div>}

        {!loading && !error && !snapshot && (
          <div className="text-muted text-sm">
            No request captured yet. Send a message, then open this modal again.
          </div>
        )}

        {snapshot && (
          <div className="space-y-3">
            <div className="text-muted text-xs">
              <span className="font-mono">{snapshot.providerName}</span>
              <span className="mx-2">•</span>
              <span className="font-mono">{snapshot.model}</span>
              <span className="mx-2">•</span>
              <span className="font-mono">thinking={snapshot.thinkingLevel}</span>
              {snapshot.mode && (
                <>
                  <span className="mx-2">•</span>
                  <span className="font-mono">mode={snapshot.mode}</span>
                </>
              )}
            </div>

            <details open>
              <summary className="cursor-pointer text-sm font-medium">System message</summary>
              <pre className="bg-code-bg text-text mt-2 max-h-[40vh] overflow-auto rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {snapshot.systemMessage}
              </pre>
            </details>

            <details>
              <summary className="cursor-pointer text-sm font-medium">Messages</summary>
              <pre className="bg-code-bg text-text mt-2 max-h-[40vh] overflow-auto rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {JSON.stringify(snapshot.messages, null, 2)}
              </pre>
            </details>

            <details>
              <summary className="cursor-pointer text-sm font-medium">Full JSON</summary>
              <pre className="bg-code-bg text-text mt-2 max-h-[40vh] overflow-auto rounded-sm p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {json}
              </pre>
            </details>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
