import React from "react";
import { BaseBarrier } from "./BaseBarrier";

interface InterruptedBarrierProps {
  /**
   * Whether this divider sits on the resumable turn (the history tail) and the
   * workspace is writable. resumeStream always continues the tail, so only the
   * tail divider is clickable; older partial dividers stay decorative.
   */
  resumable?: boolean;
  /** Resume/continue handler (owned by ChatPane); used only when `resumable`. */
  onResume?: () => void;
  /** Last resume failure, surfaced inline so a click/keybind isn't a silent no-op. */
  error?: string | null;
  className?: string;
}

/**
 * "interrupted" divider shown on a partial assistant turn. When it sits on the
 * resumable tail, clicking the label continues the stream from where it stopped
 * (same backend path as RetryBarrier / auto-retry). This is the only continue
 * affordance for user-initiated (Esc) interrupts, where RetryBarrier is
 * suppressed. The resume action and its error are owned by ChatPane so the
 * keybind path and click path share one source of truth.
 */
export const InterruptedBarrier: React.FC<InterruptedBarrierProps> = (props) => {
  return (
    <>
      <BaseBarrier
        text="interrupted"
        color="var(--color-interrupted)"
        className={props.className}
        onClick={props.resumable ? props.onResume : undefined}
        ariaLabel={props.resumable ? "Continue interrupted response" : undefined}
      />
      {props.resumable && props.error && (
        // This divider is the only continue affordance for a user-aborted stream,
        // so a resume failure must be visible or the action looks like a no-op.
        <div className="font-primary text-foreground/80 text-center text-[12px]">
          <span className="text-warning font-semibold">Couldn&apos;t continue:</span> {props.error}
        </div>
      )}
    </>
  );
};
