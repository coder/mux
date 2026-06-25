import React from "react";
import { BaseBarrier } from "./BaseBarrier";
import { useResumeStream } from "@/browser/hooks/useResumeStream";

interface InterruptedBarrierProps {
  workspaceId: string;
  className?: string;
}

/**
 * Decorative "interrupted" divider shown on a partial assistant turn. Clicking
 * the label continues the stream from where it stopped, identical to the
 * RetryBarrier's Retry button and the backend auto-retry path (resumeStream).
 * This is the only continue affordance for user-initiated (Esc) interrupts,
 * where the RetryBarrier is intentionally suppressed.
 */
export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = (props) => {
  // resume() internally guards against re-entrancy while a resume is in flight,
  // so we always keep the clickable label mounted (no button<->div remount flicker).
  const { resume } = useResumeStream(props.workspaceId);
  return (
    <BaseBarrier
      text="interrupted"
      color="var(--color-interrupted)"
      className={props.className}
      onClick={() => void resume()}
      ariaLabel="Continue interrupted response"
    />
  );
};
