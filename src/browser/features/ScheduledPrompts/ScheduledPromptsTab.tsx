import React, { useState } from "react";
import { Clock3, Play, Send, Trash2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/browser/components/Tooltip/Tooltip";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { formatTimestamp } from "@/browser/utils/ui/dateTime";
import { getScheduledPromptsKey } from "@/common/constants/storage";
import { cn } from "@/common/lib/utils";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import {
  canRunScheduledPromptNow,
  createScheduledPrompt,
  formatDateTimeLocalInput,
  normalizeScheduledPrompts,
  parseDateTimeLocalInput,
  removeScheduledPrompt,
  reschedulePromptNow,
  type ScheduledPrompt,
} from "./scheduledPrompts";

interface ScheduledPromptsTabProps {
  workspaceId: string;
}

const DEFAULT_DELAY_MS = 60 * 60 * 1000;

export function ScheduledPromptsTab(props: ScheduledPromptsTabProps) {
  const storageKey = getScheduledPromptsKey(props.workspaceId);
  const [storedPrompts, setStoredPrompts] = usePersistedState<ScheduledPrompt[]>(storageKey, [], {
    listener: true,
  });
  const prompts = normalizeScheduledPrompts(storedPrompts);
  const [content, setContent] = useState("");
  const [runAtInput, setRunAtInput] = useState(() =>
    formatDateTimeLocalInput(Date.now() + DEFAULT_DELAY_MS)
  );
  const [queueDispatchMode, setQueueDispatchMode] = useState<QueueDispatchMode>("tool-end");

  const runAt = parseDateTimeLocalInput(runAtInput);
  const canSchedule = content.trim().length > 0 && runAt !== null && runAt > Date.now();

  const addPrompt = () => {
    if (!canSchedule || runAt === null) {
      return;
    }

    const prompt = createScheduledPrompt({
      content,
      runAt,
      queueDispatchMode,
    });
    setStoredPrompts((current) => [...normalizeScheduledPrompts(current), prompt]);
    setContent("");
    setRunAtInput(formatDateTimeLocalInput(runAt + DEFAULT_DELAY_MS));
  };

  const runPromptNow = (id: string) => {
    setStoredPrompts((current) => reschedulePromptNow(normalizeScheduledPrompts(current), id));
  };

  const removePrompt = (id: string) => {
    setStoredPrompts((current) => removeScheduledPrompt(normalizeScheduledPrompts(current), id));
  };

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <section className="border-border-light bg-surface-secondary rounded-md border p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium">
          <Clock3 aria-hidden="true" className="h-4 w-4" />
          Schedule prompt
        </div>
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Prompt</span>
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              className="border-border-light bg-background text-foreground focus:ring-accent min-h-24 resize-y rounded-md border px-2 py-2 text-sm leading-5 focus:ring-1 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Run at</span>
            <input
              type="datetime-local"
              value={runAtInput}
              onChange={(event) => setRunAtInput(event.target.value)}
              className="border-border-light bg-background text-foreground focus:ring-accent rounded-md border px-2 py-1.5 text-sm focus:ring-1 focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted text-xs">Dispatch</span>
            <select
              value={queueDispatchMode}
              onChange={(event) => setQueueDispatchMode(event.target.value as QueueDispatchMode)}
              className="border-border-light bg-background text-foreground focus:ring-accent rounded-md border px-2 py-1.5 text-sm focus:ring-1 focus:outline-none"
            >
              <option value="tool-end">After step</option>
              <option value="turn-end">After turn</option>
            </select>
          </label>
          <Button type="button" size="sm" onClick={addPrompt} disabled={!canSchedule}>
            <Send aria-hidden="true" className="h-3.5 w-3.5" />
            Schedule
          </Button>
        </div>
      </section>

      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="text-muted px-1 text-xs leading-5">
          {prompts.length.toLocaleString()} scheduled prompt{prompts.length === 1 ? "" : "s"}
        </div>
        {prompts.length === 0 ? (
          <div className="text-muted flex min-h-32 flex-1 items-center justify-center text-center text-sm">
            No scheduled prompts.
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
            {prompts.map((prompt) => (
              <ScheduledPromptCard
                key={prompt.id}
                prompt={prompt}
                onRunNow={runPromptNow}
                onRemove={removePrompt}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface ScheduledPromptCardProps {
  prompt: ScheduledPrompt;
  onRunNow: (id: string) => void;
  onRemove: (id: string) => void;
}

function ScheduledPromptCard(props: ScheduledPromptCardProps) {
  const statusClassName =
    props.prompt.status === "failed"
      ? "text-error"
      : props.prompt.status === "sent"
        ? "text-success"
        : props.prompt.status === "sending"
          ? "text-accent"
          : "text-muted";

  return (
    <article className="border-border-light bg-surface-secondary overflow-hidden rounded-md border">
      <div className="px-3 py-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className={cn("text-[11px] font-medium capitalize", statusClassName)}>
            {props.prompt.status}
          </span>
          <span className="text-muted truncate text-[11px]">
            {formatTimestamp(props.prompt.runAt)}
          </span>
        </div>
        <p className="text-foreground max-h-20 overflow-hidden text-xs leading-5 whitespace-pre-wrap">
          {props.prompt.content}
        </p>
        {props.prompt.error && (
          <p className="text-error mt-2 line-clamp-2 text-xs">{props.prompt.error}</p>
        )}
      </div>
      <div className="border-border-light flex items-center justify-between gap-1 border-t px-2 py-1">
        <span className="text-muted px-1 text-[11px]">
          {props.prompt.queueDispatchMode === "turn-end" ? "After turn" : "After step"}
        </span>
        <div className="flex items-center gap-1">
          {props.prompt.status !== "sent" && canRunScheduledPromptNow(props.prompt) && (
            <ScheduledPromptIconButton
              label="Run now"
              onClick={() => props.onRunNow(props.prompt.id)}
            >
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
            </ScheduledPromptIconButton>
          )}
          <ScheduledPromptIconButton label="Delete" onClick={() => props.onRemove(props.prompt.id)}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </ScheduledPromptIconButton>
        </div>
      </div>
    </article>
  );
}

interface ScheduledPromptIconButtonProps {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}

function ScheduledPromptIconButton(props: ScheduledPromptIconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={props.label}
          className="text-muted hover:text-foreground hover:bg-accent/50 flex h-7 w-7 items-center justify-center rounded-sm transition-colors"
          onClick={props.onClick}
        >
          {props.children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{props.label}</TooltipContent>
    </Tooltip>
  );
}
