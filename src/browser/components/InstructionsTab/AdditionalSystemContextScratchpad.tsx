import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import {
  updateAdditionalSystemContextSnapshot,
  useAdditionalSystemContextSnapshot,
} from "@/browser/utils/additionalSystemContextStore";
import { cn } from "@/common/lib/utils";
import { getErrorMessage } from "@/common/utils/errors";

function getFirstLinePreview(content: string): string {
  return content.split(/\r?\n/, 1)[0]?.trim() || "(blank first line)";
}

interface ScratchpadState {
  content: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  setContent: (content: string) => void;
}

export function useAdditionalSystemContextScratchpad(workspaceId: string): ScratchpadState {
  const { api } = useAPI();
  const content = useAdditionalSystemContextSnapshot(workspaceId);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const inFlightSaveRef = useRef(false);
  const pendingSaveRef = useRef<string | null>(null);
  const saveGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    saveGenerationRef.current += 1;
    dirtyRef.current = false;
    pendingSaveRef.current = null;
    inFlightSaveRef.current = false;
    setLoading(true);
    setSaving(false);
    setError(null);

    if (!api) return;

    let cancelled = false;
    api.workspace
      .getAdditionalSystemContext({ workspaceId })
      .then((result) => {
        if (cancelled || !mountedRef.current) return;
        if (!dirtyRef.current) {
          updateAdditionalSystemContextSnapshot(workspaceId, result.content);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        setError(getErrorMessage(err));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [api, workspaceId]);

  const flushSave = () => {
    if (!api || inFlightSaveRef.current) return;
    const next = pendingSaveRef.current;
    if (next == null) return;

    const saveGeneration = saveGenerationRef.current;
    pendingSaveRef.current = null;
    inFlightSaveRef.current = true;
    setSaving(true);
    setError(null);

    api.workspace
      .setAdditionalSystemContext({ workspaceId, content: next })
      .then((result) => {
        if (!mountedRef.current || saveGeneration !== saveGenerationRef.current) return;
        updateAdditionalSystemContextSnapshot(workspaceId, result.content);
      })
      .catch((err) => {
        if (!mountedRef.current || saveGeneration !== saveGenerationRef.current) return;
        setError(getErrorMessage(err));
      })
      .finally(() => {
        if (!mountedRef.current || saveGeneration !== saveGenerationRef.current) return;
        inFlightSaveRef.current = false;
        if (pendingSaveRef.current == null) {
          setSaving(false);
        }
        flushSave();
      });
  };

  const setContent = (next: string) => {
    dirtyRef.current = true;
    updateAdditionalSystemContextSnapshot(workspaceId, next);
    pendingSaveRef.current = next;
    flushSave();
  };

  return { content, loading, saving, error, setContent };
}

interface AdditionalSystemContextEditorProps {
  workspaceId: string;
  className?: string;
  textareaClassName?: string;
  minRows?: number;
  placeholder?: string;
}

export function AdditionalSystemContextEditor(props: AdditionalSystemContextEditorProps) {
  const state = useAdditionalSystemContextScratchpad(props.workspaceId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [state.content]);

  return (
    <div className={cn("space-y-1.5", props.className)}>
      <textarea
        ref={textareaRef}
        value={state.content}
        rows={props.minRows ?? 3}
        onChange={(event) => state.setContent(event.currentTarget.value)}
        placeholder={
          props.placeholder ??
          "Add workspace-specific context that should be appended to the system prompt…"
        }
        className={cn(
          "border-border bg-background text-foreground placeholder:text-muted min-h-[72px] w-full resize-none overflow-hidden rounded border px-3 py-2 text-xs leading-5 outline-none focus:ring-1 focus:ring-[var(--color-accent)]",
          props.textareaClassName
        )}
        aria-label="Additional system context scratchpad"
        disabled={state.loading}
      />
      <div className="text-muted flex min-h-4 items-center justify-between gap-2 text-[10px]">
        <span>{state.loading ? "Loading…" : state.saving ? "Saving…" : "Saved automatically"}</span>
        {state.error && <span className="text-destructive truncate">{state.error}</span>}
      </div>
    </div>
  );
}

export function AdditionalSystemContextPanel(props: { workspaceId: string }) {
  return (
    <section className="border-border border-b px-3 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-xs font-medium">Additional system context</h3>
          <p className="text-muted mt-0.5 text-[10px]">
            Scratchpad appended to the system prompt for every turn in this workspace.
          </p>
        </div>
      </div>
      <AdditionalSystemContextEditor workspaceId={props.workspaceId} />
    </section>
  );
}

export function AdditionalSystemContextChatDecoration(props: { workspaceId: string }) {
  const state = useAdditionalSystemContextScratchpad(props.workspaceId);
  const [expanded, setExpanded] = useState(false);
  const hasContent = state.content.trim().length > 0;

  if (state.loading || (!expanded && !hasContent)) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4">
      <div className="border-border bg-muted/10 rounded-lg border text-xs">
        <button
          type="button"
          className="hover:bg-accent/20 flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left transition-colors"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="text-muted h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted h-3.5 w-3.5 shrink-0" />
          )}
          <span className="font-medium">Additional system context</span>
          {!expanded && (
            <span className="text-muted min-w-0 truncate">
              {getFirstLinePreview(state.content)}
            </span>
          )}
        </button>
        {expanded && (
          <div className="border-border border-t p-3">
            <AdditionalSystemContextEditor
              workspaceId={props.workspaceId}
              minRows={2}
              textareaClassName="bg-background/80"
            />
          </div>
        )}
      </div>
    </div>
  );
}
