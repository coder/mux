import React from "react";
import { BaseBarrier } from "./BaseBarrier";
import { useResumeStream } from "@/browser/hooks/useResumeStream";

interface InterruptedBarrierProps {
  workspaceId: string;
  /**
   * Whether this divider sits on the current resume target (the history tail).
   * resumeStream always continues the tail, so only the tail divider is made
   * clickable — older partial dividers stay decorative to avoid resuming the
   * wrong turn.
   */
  resumable?: boolean;
  className?: string;
}

/**
 * "interrupted" divider shown on a partial assistant turn. When it sits on the
 * resumable tail, clicking the label continues the stream from where it stopped
 * (same backend path as RetryBarrier / auto-retry). It is the only continue
 * affordance for user-initiated (Esc) interrupts, where RetryBarrier is
 * suppressed. autoRetryOnFailure is disabled because ChatPane unmounts this
 * divider once auto-retry becomes active; see useResumeStream for why that
 * matters.
 */
export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = (props) => {
  // resume() internally guards against re-entrancy while a resume is in flight.
  const { resume, error } = useResumeStream(props.workspaceId, { autoRetryOnFailure: false });
  return (
    <>
      <BaseBarrier
        text="interrupted"
        color="var(--color-interrupted)"
        className={props.className}
        onClick={props.resumable ? () => void resume() : undefined}
        ariaLabel={props.resumable ? "Continue interrupted response" : undefined}
      />
      {props.resumable && error && (
        // This divider is the only continue affordance for a user-aborted stream,
        // so a resume failure must be visible or the click looks like a no-op.
        <div className="font-primary text-foreground/80 text-center text-[12px]">
          <span className="text-warning font-semibold">Couldn&apos;t continue:</span> {error}
        </div>
      )}
    </>
  );
};
