import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import { Input } from "@/browser/components/ui/input";
import type { RuntimeConfig } from "@/common/types/runtime";
import { useWorkspaceActions } from "@/browser/contexts/WorkspaceContext";

interface ChangeSSHHostDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  currentRuntimeConfig: Extract<RuntimeConfig, { type: "ssh" }>;
}

export function ChangeSSHHostDialog(props: ChangeSSHHostDialogProps) {
  const { updateWorkspaceRuntimeConfig } = useWorkspaceActions();
  const [host, setHost] = useState(props.currentRuntimeConfig.host);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset when dialog opens with new config
  useEffect(() => {
    if (props.open) {
      setHost(props.currentRuntimeConfig.host);
      setError(null);
      setSaving(false);
    }
  }, [props.open, props.currentRuntimeConfig.host]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedHost = host.trim();
    if (!trimmedHost) {
      setError("Host is required");
      return;
    }
    if (trimmedHost === props.currentRuntimeConfig.host) {
      props.onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    const result = await updateWorkspaceRuntimeConfig(props.workspaceId, {
      ...props.currentRuntimeConfig,
      host: trimmedHost,
    });
    setSaving(false);
    if (result.success) {
      props.onOpenChange(false);
    } else {
      setError(result.error ?? "Failed to update SSH host");
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent maxWidth="380px" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Change SSH Host</DialogTitle>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-foreground-secondary text-xs">SSH Host</span>
            <Input
              type="text"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setError(null);
              }}
              placeholder="user@hostname or SSH config alias"
              autoFocus
              disabled={saving}
            />
          </label>
          {error && <p className="text-error text-xs">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={saving}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving || !host.trim()}>
              {saving ? "Saving\u2026" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
