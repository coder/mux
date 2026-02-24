import { createPortal } from "react-dom";
import { AlertTriangle } from "lucide-react";
import type { PopoverErrorState } from "@/browser/hooks/usePopoverError";

interface PopoverErrorProps {
  error: PopoverErrorState | null;
  prefix: string;
  onDismiss?: () => void;
}

/**
 * Floating error popover that displays near the trigger element.
 * Styled to match the app's toast error design.
 */
export function PopoverError(props: PopoverErrorProps) {
  if (!props.error) return null;

  return createPortal(
    <div
      role="alert"
      aria-live="assertive"
      className="bg-dark border-toast-error-border text-toast-error-text pointer-events-auto fixed z-[10000] flex max-w-80 animate-[toastSlideIn_0.2s_ease-out] items-start gap-2 rounded border px-3 py-2 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
      style={{
        top: `${props.error.position.top}px`,
        left: `${props.error.position.left}px`,
      }}
    >
      <AlertTriangle aria-hidden="true" className="h-4 w-4" />
      <div className="flex-1 leading-[1.4] break-words whitespace-pre-wrap">
        <span className="font-medium">{props.prefix}</span>
        <p className="text-light mt-1">{props.error.error}</p>
      </div>
      {props.onDismiss && (
        <button
          onClick={props.onDismiss}
          aria-label="Dismiss"
          className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
        >
          ×
        </button>
      )}
    </div>,
    document.body
  );
}
