import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  WarningBox,
  WarningTitle,
  WarningText,
} from "@/browser/components/ui/dialog";
import { Button } from "@/browser/components/ui/button";
import type { HostKeyVerificationRequest } from "@/common/orpc/schemas/ssh";

export function HostKeyVerificationDialog() {
  const { api } = useAPI();
  const [pendingQueue, setPendingQueue] = useState<HostKeyVerificationRequest[]>([]);
  const pending = pendingQueue[0] ?? null;
  const [responding, setResponding] = useState(false);

  useEffect(() => {
    if (!api) {
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // Global subscription: backend can request host-key verification at any time.
    // Queue pending requests so concurrent prompts are handled FIFO without drops.
    (async () => {
      try {
        const iterator = await api.ssh.hostKeyVerification.subscribe(undefined, { signal });

        for await (const request of iterator) {
          if (signal.aborted) {
            break;
          }

          setPendingQueue((prev) =>
            prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request]
          );
        }
      } catch {
        // Subscription closed (cleanup/reconnect): no-op
      }
    })();

    return () => controller.abort();
  }, [api]);

  const respond = async (accept: boolean) => {
    if (!api || !pending || responding) {
      return;
    }

    const requestId = pending.requestId;
    setResponding(true);

    try {
      await api.ssh.hostKeyVerification.respond({ requestId, accept });
    } finally {
      setResponding(false);
      setPendingQueue((prev) => prev.filter((item) => item.requestId !== requestId));
    }
  };

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        // Treat dismiss/escape as explicit rejection so backend unblocks promptly.
        if (!open && !responding) {
          void respond(false);
        }
      }}
    >
      <DialogContent maxWidth="500px" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Unknown SSH Host</DialogTitle>
          <DialogDescription>
            {pending?.prompt ?? (
              <>
                The authenticity of host{" "}
                <code className="text-foreground font-semibold">{pending?.host}</code> cannot be
                established.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="bg-background-secondary border-border rounded p-3 font-mono text-sm">
          <div className="text-muted">{pending?.keyType} key fingerprint:</div>
          <div className="text-foreground mt-1 break-all select-all">{pending?.fingerprint}</div>
        </div>

        <WarningBox>
          <WarningTitle>Host Key Verification</WarningTitle>
          <WarningText>Accepting will add the host to your known_hosts file.</WarningText>
        </WarningBox>

        <DialogFooter className="justify-center">
          <Button
            variant="secondary"
            disabled={responding}
            onClick={() => {
              void respond(false);
            }}
          >
            Reject
          </Button>
          <Button
            variant="default"
            disabled={responding}
            onClick={() => {
              void respond(true);
            }}
          >
            {responding ? "Connecting..." : "Accept & Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
