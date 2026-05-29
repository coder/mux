import React, { useEffect, useState } from "react";
import assert from "@/common/utils/assert";
import { useAPI } from "@/browser/contexts/API";
import { MarkdownCore } from "@/browser/features/Messages/MarkdownCore";
import { PlanMarkdownContainer } from "@/browser/features/Messages/MarkdownRenderer";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { getErrorMessage } from "@/common/utils/errors";

interface PlanFileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
}

export const PlanFileDialog: React.FC<PlanFileDialogProps> = (props) => {
  const { api } = useAPI();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    // PostCompactionSection renders this dialog while closed.
    // Delay IPC plan-file reads until the user explicitly opens the preview.
    if (!props.open) {
      return;
    }

    assert(props.workspaceId.trim().length > 0, "workspaceId is required to load plan preview");

    setIsLoading(true);
    setError(null);
    setContent(null);
    setPath(null);

    if (!api) {
      setIsLoading(false);
      setError("API unavailable");
      return;
    }

    let cancelled = false;

    const run = async () => {
      try {
        const result = await api.workspace.getPlanContent({ workspaceId: props.workspaceId });

        if (cancelled) {
          return;
        }

        if (!result.success) {
          setError(result.error);
          setIsLoading(false);
          return;
        }

        assert(result.data.path.length > 0, "Plan path should be non-empty");

        setContent(result.data.content);
        setPath(result.data.path);
        setIsLoading(false);
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }

        setError(getErrorMessage(error));
        setIsLoading(false);
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [api, props.open, props.workspaceId]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[80vh] min-h-0 max-w-5xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex flex-col gap-1">
            <span>Plan file</span>
            {path && (
              <code className="rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px]">
                {path}
              </code>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto rounded bg-[var(--color-bg-secondary)] p-3">
          {error ? (
            <div className="text-error text-[11px]" data-testid="plan-file-dialog-error">
              {error}
            </div>
          ) : isLoading ? (
            <div className="text-muted text-[11px] italic">Loading plan…</div>
          ) : content !== null ? (
            content.length > 0 ? (
              <PlanMarkdownContainer>
                <MarkdownCore content={content} />
              </PlanMarkdownContainer>
            ) : (
              <div className="text-muted text-[11px] italic">Plan file is empty</div>
            )
          ) : (
            <div className="text-muted text-[11px] italic">No plan loaded</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
