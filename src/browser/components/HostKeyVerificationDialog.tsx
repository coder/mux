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
import type {
  HostKeyVerificationEvent,
  HostKeyVerificationRequest,
} from "@/common/orpc/schemas/ssh";

export function HostKeyVerificationDialog() {
  const { api } = useAPI();
  const [pendingQueue, setPendingQueue] = useState<HostKeyVerificationRequest[]>([]);
  const pending = pendingQueue[0] ?? null;
  const [responding, setResponding] = useState(false);

  useEffect(() => {
    if (!api) {
      setPendingQueue([]);
      return;
    }

    const controller = new AbortController();
    const { signal } = controller;

    // Track the async iterator so we can explicitly close it on cleanup.
    // Some oRPC iterators don't reliably terminate on abort alone;
    // calling return() ensures the backend subscription finally block runs,
    // which releases the responder lease and listener state.
    let iteratorRef: AsyncIterator<HostKeyVerificationEvent> | undefined;

    // Global subscription: backend can request host-key verification at any time.
    // Queue pending requests so concurrent prompts are handled FIFO without drops.
    (async () => {
      try {
        const iterable = await api.ssh.hostKeyVerification.subscribe(undefined, { signal });
        // Consume and cleanup the same iterator instance —
        // for-await-of would call [Symbol.asyncIterator]() again,
        // creating a second iterator that cleanup can't reach.
        const iterator = iterable[Symbol.asyncIterator]();

        // If cleanup ran while subscribe() was in-flight, close the late
        // iterator now — nobody else will call return() on it.
        if (signal.aborted) {
          void iterator.return?.(undefined);
          return;
        }

        iteratorRef = iterator;

        while (!signal.aborted) {
          const { value: event, done } = await iterator.next();
          if (done) {
            break;
          }

          if (event.type === "removed") {
            // Backend finalized this request (timeout or another subscriber responded).
            setPendingQueue((prev) => prev.filter((item) => item.requestId !== event.requestId));
          } else {
            const { type: _, ...request } = event;
            setPendingQueue((prev) =>
              prev.some((item) => item.requestId === request.requestId) ? prev : [...prev, request]
            );
          }
        }
      } catch {
        // Subscription closed (cleanup/reconnect): no-op
      }
    })();

    return () => {
      controller.abort();
      void iteratorRef?.return?.(undefined);
      setPendingQueue([]); // Drop stale prompts; reconnect delivers fresh snapshot
    };
  }, [api]);

  const respond = async (accept: boolean) => {
    if (!api || !pending || responding) {
      return;
    }

    const requestId = pending.requestId;
    setResponding(true);

    try {
      await api.ssh.hostKeyVerification.respond({ requestId, accept });
      // Dequeue only on success — RPC failure keeps prompt visible for retry.
      setPendingQueue((prev) => prev.filter((item) => item.requestId !== requestId));
    } catch {
      // Transport/RPC failure: keep current request in queue so user can retry.
    } finally {
      setResponding(false);
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
