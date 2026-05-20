import React, { useEffect, useRef, useState } from "react";
import { Loader2, Moon } from "lucide-react";
import { Button } from "@/browser/components/Button/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/browser/components/Dialog/Dialog";
import { Input } from "@/browser/components/Input/Input";
import { useAPI } from "@/browser/contexts/API";
import { useWorkspaceActions, useWorkspaceMetadata } from "@/browser/contexts/WorkspaceContext";
import { cn } from "@/common/lib/utils";
import {
  formatDurationShort,
  isWorkspaceSnoozed,
  parseHumanDurationMs,
} from "@/common/utils/snooze";

interface SnoozePreset {
  label: string;
  durationToken: string;
}

/**
 * Curated preset list — matches the durations called out by the
 * `/snooze <duration>` slash command help so the modal and command surface
 * stay in lockstep. Custom durations are supported via the input field.
 */
const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { label: "1 hour", durationToken: "1h" },
  { label: "4 hours", durationToken: "4h" },
  { label: "Tomorrow", durationToken: "1d" },
  { label: "3 days", durationToken: "3d" },
  { label: "1 week", durationToken: "1w" },
];

interface WorkspaceSnoozeModalProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Modal companion to `/snooze <duration>`. Lets the user pick a preset
 * duration or type a custom one (e.g. `15m`, `2h`, `1w`); shows the
 * equivalent slash command live so the muscle-memory keyboard flow is
 * discoverable from the menu/keybind entry point.
 */
export function WorkspaceSnoozeModal(props: WorkspaceSnoozeModalProps) {
  const { api } = useAPI();
  const { snoozeWorkspace } = useWorkspaceActions();
  const { workspaceMetadata } = useWorkspaceMetadata();
  const metadata = workspaceMetadata.get(props.workspaceId);
  const currentSnoozedUntil = metadata?.snoozedUntil;
  const isCurrentlySnoozed = isWorkspaceSnoozed(currentSnoozedUntil);

  const [selectedDuration, setSelectedDuration] = useState<string>(SNOOZE_PRESETS[2].durationToken);
  const [customDuration, setCustomDuration] = useState<string>("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resets draft state whenever the modal reopens so a previously-typed
  // custom value doesn't surprise the user on the next snooze gesture.
  const previousOpenRef = useRef(props.open);
  useEffect(() => {
    if (props.open && !previousOpenRef.current) {
      setSelectedDuration(SNOOZE_PRESETS[2].durationToken);
      setCustomDuration("");
      setError(null);
      setIsSaving(false);
    }
    previousOpenRef.current = props.open;
  }, [props.open]);

  // Derive the active duration token (preset or custom). When the custom
  // field has content we prefer it so the live `/snooze <X>` hint reflects
  // what the user is actually about to submit.
  const customDurationMs = customDuration.trim() ? parseHumanDurationMs(customDuration) : null;
  const effectiveDurationToken = (() => {
    if (customDuration.trim().length > 0) {
      return customDurationMs != null ? formatDurationShort(customDurationMs) : null;
    }
    return selectedDuration;
  })();
  const effectiveDurationMs = (() => {
    if (customDuration.trim().length > 0) return customDurationMs;
    return parseHumanDurationMs(selectedDuration);
  })();
  const equivalentCommand = effectiveDurationToken
    ? `/snooze ${effectiveDurationToken}`
    : "/snooze <duration>";
  const hasInvalidCustom = customDuration.trim().length > 0 && customDurationMs == null;
  const canSnooze = !isSaving && !hasInvalidCustom && effectiveDurationMs != null && api != null;

  const handleSnooze = async () => {
    if (!effectiveDurationMs || !api) {
      return;
    }
    setIsSaving(true);
    setError(null);
    const deadline = new Date(Date.now() + effectiveDurationMs).toISOString();
    const result = await snoozeWorkspace(props.workspaceId, deadline);
    if (result.success) {
      props.onOpenChange(false);
    } else {
      setError(result.error ?? "Failed to snooze workspace");
    }
    setIsSaving(false);
  };

  const handleUnsnooze = async () => {
    if (!api) return;
    setIsSaving(true);
    setError(null);
    const result = await snoozeWorkspace(props.workspaceId, null);
    if (result.success) {
      props.onOpenChange(false);
    } else {
      setError(result.error ?? "Failed to clear snooze");
    }
    setIsSaving(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Moon className="h-5 w-5" />
            Snooze chat
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-muted text-sm">
            Hide this chat from the main sidebar until the timer expires. Snoozed chats live under a
            dedicated <span className="text-foreground">Snoozed</span> section and return
            automatically when their deadline passes.
          </p>

          {isCurrentlySnoozed && currentSnoozedUntil && (
            <div className="border-border bg-background-secondary rounded-lg border p-3 text-sm">
              <div className="text-foreground font-medium">Currently snoozed</div>
              <div className="text-muted mt-1 text-xs">
                Until {new Date(currentSnoozedUntil).toLocaleString()}
              </div>
            </div>
          )}

          <div>
            <div className="text-foreground mb-2 text-sm font-medium">Choose a duration</div>
            <div className="flex flex-wrap gap-2">
              {SNOOZE_PRESETS.map((preset) => {
                const isSelected =
                  customDuration.trim().length === 0 && preset.durationToken === selectedDuration;
                return (
                  <button
                    key={preset.durationToken}
                    type="button"
                    onClick={() => {
                      setSelectedDuration(preset.durationToken);
                      setCustomDuration("");
                    }}
                    className={cn(
                      "border-border-medium hover:border-accent rounded-md border px-3 py-1.5 text-xs transition-colors",
                      isSelected
                        ? "bg-accent/10 text-foreground border-accent"
                        : "text-content-secondary bg-background-secondary"
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="snooze-custom-duration" className="block">
              <div className="text-foreground text-sm font-medium">Custom duration</div>
              <div className="text-muted mt-1 text-xs">
                Accepts {/* keep examples in sync with parseHumanDurationMs */}
                <code>15m</code>, <code>2h</code>, <code>3d</code>, or <code>1w</code>.
              </div>
            </label>
            <Input
              id="snooze-custom-duration"
              value={customDuration}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                setCustomDuration(event.target.value);
              }}
              placeholder="e.g. 90m"
              disabled={isSaving}
              className="border-border-medium bg-background-secondary"
              aria-label="Custom snooze duration"
            />
            {hasInvalidCustom && (
              <p className="text-danger-soft text-xs">
                Could not parse that duration — try a value like <code>15m</code>, <code>2h</code>,{" "}
                <code>3d</code>, or <code>1w</code>.
              </p>
            )}
          </div>

          <div className="border-border-light bg-background-secondary rounded-md border px-3 py-2 text-xs">
            <span className="text-muted">Equivalent command:</span>{" "}
            <code className="text-foreground">{equivalentCommand}</code>
          </div>

          {error && (
            <div className="bg-danger-soft/10 text-danger-soft rounded-md p-3 text-sm">{error}</div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={isSaving}>
              Cancel
            </Button>
            {isCurrentlySnoozed && (
              <Button
                variant="ghost"
                onClick={() => void handleUnsnooze()}
                disabled={isSaving || !api}
              >
                Unsnooze
              </Button>
            )}
            <Button onClick={() => void handleSnooze()} disabled={!canSnooze}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Snooze
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
