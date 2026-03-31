import React, { useEffect, useRef, useState } from "react";
import { HeartPulse, Loader2 } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Input } from "@/browser/components/Input/Input";
import { Switch } from "@/browser/components/Switch/Switch";
import { useWorkspaceHeartbeat } from "@/browser/hooks/useWorkspaceHeartbeat";
import assert from "@/common/utils/assert";
import {
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  HEARTBEAT_DEFAULT_MESSAGE_BODY,
  HEARTBEAT_MAX_INTERVAL_MS,
  HEARTBEAT_MAX_MESSAGE_LENGTH,
  HEARTBEAT_MIN_INTERVAL_MS,
} from "@/constants/heartbeat";

const MS_PER_MINUTE = 60_000;
const HEARTBEAT_MIN_INTERVAL_MINUTES = HEARTBEAT_MIN_INTERVAL_MS / MS_PER_MINUTE;
const HEARTBEAT_MAX_INTERVAL_MINUTES = HEARTBEAT_MAX_INTERVAL_MS / MS_PER_MINUTE;
const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = HEARTBEAT_DEFAULT_INTERVAL_MS / MS_PER_MINUTE;

assert(
  Number.isInteger(HEARTBEAT_MIN_INTERVAL_MINUTES),
  "Workspace heartbeat minimum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(HEARTBEAT_MAX_INTERVAL_MINUTES),
  "Workspace heartbeat maximum interval must be a whole number of minutes"
);
assert(
  Number.isInteger(HEARTBEAT_DEFAULT_INTERVAL_MINUTES),
  "Workspace heartbeat default interval must be a whole number of minutes"
);

interface WorkspaceHeartbeatModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatIntervalMinutes(intervalMs: number): string {
  if (!Number.isFinite(intervalMs)) {
    return String(HEARTBEAT_DEFAULT_INTERVAL_MINUTES);
  }

  const roundedMinutes = Math.round(intervalMs / MS_PER_MINUTE);
  return String(clampIntervalMinutes(roundedMinutes));
}

function parseIntervalMinutes(value: string): number | null {
  const trimmedValue = value.trim();
  if (trimmedValue.length === 0 || !/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const minutes = Number.parseInt(trimmedValue, 10);
  return Number.isInteger(minutes) ? minutes : null;
}

function clampIntervalMinutes(minutes: number): number {
  assert(Number.isInteger(minutes), "Workspace heartbeat minutes must be a whole number");
  return Math.min(
    HEARTBEAT_MAX_INTERVAL_MINUTES,
    Math.max(HEARTBEAT_MIN_INTERVAL_MINUTES, minutes)
  );
}

function getValidationErrorMessage(value: string): string | null {
  const minutes = parseIntervalMinutes(value);
  if (minutes == null) {
    return "Heartbeat interval must be a whole number of minutes.";
  }

  if (minutes < HEARTBEAT_MIN_INTERVAL_MINUTES || minutes > HEARTBEAT_MAX_INTERVAL_MINUTES) {
    return `Heartbeat interval must be between ${HEARTBEAT_MIN_INTERVAL_MINUTES} and ${HEARTBEAT_MAX_INTERVAL_MINUTES} minutes.`;
  }

  return null;
}

function normalizeDraftMessage(value: string): string | undefined {
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
}

function getDraftMessageForSave(value: string): string {
  return normalizeDraftMessage(value) ?? "";
}

export function WorkspaceHeartbeatModal(props: WorkspaceHeartbeatModalProps) {
  const { settings, isLoading, isSaving, error, save } = useWorkspaceHeartbeat({
    workspaceId: props.open ? props.workspaceId : null,
  });
  const [draftEnabled, setDraftEnabled] = useState(false);
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState(
    formatIntervalMinutes(HEARTBEAT_DEFAULT_INTERVAL_MS)
  );
  const [draftMessage, setDraftMessage] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const previousOpenRef = useRef(props.open);
  const previousWorkspaceIdRef = useRef(props.workspaceId);
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const lastSyncedSettingsRef = useRef<Pick<
    typeof settings,
    "enabled" | "intervalMs" | "message"
  > | null>(null);

  useEffect(() => {
    const didOpen = props.open && !previousOpenRef.current;
    const workspaceChanged = previousWorkspaceIdRef.current !== props.workspaceId;
    const lastSyncedSettings = lastSyncedSettingsRef.current;
    const settingsChanged =
      lastSyncedSettings == null ||
      lastSyncedSettings.enabled !== settings.enabled ||
      lastSyncedSettings.intervalMs !== settings.intervalMs ||
      lastSyncedSettings.message !== settings.message;

    previousOpenRef.current = props.open;
    previousWorkspaceIdRef.current = props.workspaceId;

    if (!props.open || isLoading) {
      return;
    }

    // Re-sync untouched drafts when freshly loaded settings arrive, but preserve in-progress edits.
    if (didOpen || workspaceChanged || (!draftDirty && settingsChanged)) {
      setDraftEnabled(settings.enabled);
      setDraftIntervalMinutes(formatIntervalMinutes(settings.intervalMs));
      setDraftMessage(settings.message ?? "");
      setDraftDirty(false);
      lastSyncedSettingsRef.current = {
        enabled: settings.enabled,
        intervalMs: settings.intervalMs,
        message: settings.message,
      };
    }
  }, [
    draftDirty,
    isLoading,
    props.open,
    props.workspaceId,
    settings.enabled,
    settings.intervalMs,
    settings.message,
  ]);

  const validationError = getValidationErrorMessage(draftIntervalMinutes);
  const errorMessages = [validationError, error].filter(
    (message): message is string => message != null
  );
  const hasBlockingError = isLoading || isSaving || validationError != null;

  const handleIntervalBlur = () => {
    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);
    if (parsedMinutes == null) {
      return;
    }

    const clampedMinutes = clampIntervalMinutes(parsedMinutes);
    const clampedMinutesValue = String(clampedMinutes);
    if (clampedMinutesValue !== draftIntervalMinutes) {
      setDraftIntervalMinutes(clampedMinutesValue);
      setDraftDirty(true);
    }
  };

  const handleSave = async () => {
    const parsedMinutes = parseIntervalMinutes(draftIntervalMinutes);
    assert(parsedMinutes != null, "Save should only run with a valid heartbeat interval");
    assert(
      parsedMinutes >= HEARTBEAT_MIN_INTERVAL_MINUTES &&
        parsedMinutes <= HEARTBEAT_MAX_INTERVAL_MINUTES,
      "Save should only run with a heartbeat interval inside the supported range"
    );

    const didSave = await save({
      enabled: draftEnabled,
      intervalMs: parsedMinutes * MS_PER_MINUTE,
      // Read directly from the textarea on save so the final keystroke is preserved even if the
      // click lands before React finishes flushing the last state update.
      message: getDraftMessageForSave(messageTextareaRef.current?.value ?? draftMessage),
    });
    if (didSave) {
      props.onOpenChange(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HeartPulse className="h-5 w-5" />
            Configure heartbeat
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="text-muted h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-muted text-sm">
              Schedule future background follow-ups for this workspace. Valid range:{" "}
              {HEARTBEAT_MIN_INTERVAL_MINUTES}–{HEARTBEAT_MAX_INTERVAL_MINUTES} minutes. New
              workspaces default to {HEARTBEAT_DEFAULT_INTERVAL_MINUTES} minutes unless you change
              them.
            </p>

            <div className="border-border rounded-lg border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Enable heartbeats</div>
                  <div className="text-muted mt-1 text-xs">
                    Keep this workspace eligible for future background heartbeat follow-ups.
                  </div>
                </div>
                <Switch
                  checked={draftEnabled}
                  onCheckedChange={(checked) => {
                    setDraftEnabled(checked);
                    setDraftDirty(true);
                  }}
                  disabled={isSaving}
                  aria-label="Enable workspace heartbeats"
                />
              </div>

              <div className="mt-4 flex items-center justify-between gap-4">
                <label htmlFor="workspace-heartbeat-interval" className="min-w-0 flex-1">
                  <div className="text-foreground text-sm font-medium">Interval</div>
                  <div className="text-muted mt-1 text-xs">Heartbeat cadence in minutes.</div>
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="workspace-heartbeat-interval"
                    type="number"
                    inputMode="numeric"
                    min={HEARTBEAT_MIN_INTERVAL_MINUTES}
                    max={HEARTBEAT_MAX_INTERVAL_MINUTES}
                    step={1}
                    value={draftIntervalMinutes}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      setDraftIntervalMinutes(event.target.value);
                      setDraftDirty(true);
                    }}
                    onBlur={handleIntervalBlur}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary h-9 w-24 text-right"
                    aria-label="Heartbeat interval in minutes"
                  />
                  <span className="text-muted text-sm">min</span>
                </div>
              </div>

              {draftEnabled && (
                <div className="mt-4 space-y-2">
                  <label htmlFor="workspace-heartbeat-message" className="block">
                    <div className="text-foreground text-sm font-medium">Message</div>
                    <div className="text-muted mt-1 text-xs">
                      Leave empty to use the default heartbeat message.
                    </div>
                  </label>
                  <textarea
                    ref={messageTextareaRef}
                    id="workspace-heartbeat-message"
                    rows={4}
                    maxLength={HEARTBEAT_MAX_MESSAGE_LENGTH}
                    value={draftMessage}
                    onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => {
                      setDraftMessage(event.target.value);
                      setDraftDirty(true);
                    }}
                    disabled={isSaving}
                    className="border-border-medium bg-background-secondary text-foreground focus:border-accent focus:ring-accent min-h-[120px] w-full resize-y rounded-md border p-3 text-sm leading-relaxed focus:ring-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder={HEARTBEAT_DEFAULT_MESSAGE_BODY}
                    aria-label="Heartbeat message"
                  />
                  <div className="text-muted text-xs">
                    Max {HEARTBEAT_MAX_MESSAGE_LENGTH} characters.
                  </div>
                </div>
              )}
            </div>

            {errorMessages.length > 0 && (
              <div className="bg-danger-soft/10 text-danger-soft space-y-1 rounded-md p-3 text-sm">
                {errorMessages.map((message) => (
                  <p key={message}>{message}</p>
                ))}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={isSaving}>
                Cancel
              </Button>
              <Button onClick={() => void handleSave()} disabled={hasBlockingError}>
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
