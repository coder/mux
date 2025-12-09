import type { ReactNode } from "react";
import React, { useEffect, useCallback } from "react";
import { cn } from "@/common/lib/utils";

const toastTypeStyles: Record<"success" | "error", string> = {
  success: "bg-toast-success-bg border border-accent-dark text-toast-success-text",
  error: "bg-toast-error-bg border border-toast-error-border text-toast-error-text",
};

export interface Toast {
  id: string;
  type: "success" | "error";
  title?: string;
  message: string;
  solution?: ReactNode;
  duration?: number;
}

interface ChatInputToastProps {
  toast: Toast | null;
  onDismiss: () => void;
}

export const SolutionLabel: React.FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-muted-light mb-1 text-[10px] uppercase">{children}</div>
);

export const ChatInputToast: React.FC<ChatInputToastProps> = ({ toast, onDismiss }) => {
  const [isLeaving, setIsLeaving] = React.useState(false);

  const handleDismiss = useCallback(() => {
    setIsLeaving(true);
    setTimeout(onDismiss, 200); // Wait for fade animation
  }, [onDismiss]);

  useEffect(() => {
    if (!toast) return;

    // Only auto-dismiss success toasts
    if (toast.type === "success") {
      // Use longer duration in E2E tests to give assertions time to observe the toast
      const e2eDuration = 10_000;
      const defaultDuration = 3000;
      const duration = toast.duration ?? (window.api?.isE2E ? e2eDuration : defaultDuration);
      const timer = setTimeout(() => {
        handleDismiss();
      }, duration);

      return () => {
        clearTimeout(timer);
      };
    }

    // Error toasts stay until manually dismissed
    return () => {
      setIsLeaving(false);
    };
  }, [toast, handleDismiss]);

  if (!toast) return null;

  // Use rich error style when there's a title or solution
  const isRichError = toast.type === "error" && (toast.title ?? toast.solution);

  if (isRichError) {
    return (
      <div className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 [&>*]:pointer-events-auto">
        <div
          role="alert"
          aria-live="assertive"
          className="bg-toast-fatal-bg border-toast-fatal-border text-danger-soft animate-[toastSlideIn_0.2s_ease-out] rounded border px-3 py-2.5 text-xs shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
        >
          <div className="flex items-start gap-1.5">
            <span className="text-sm leading-none">⚠</span>
            <div className="flex-1">
              {toast.title && <div className="mb-1.5 font-semibold">{toast.title}</div>}
              <div className="text-light mt-1.5 leading-[1.4]">{toast.message}</div>
              {toast.solution && (
                <div className="bg-dark font-monospace text-code-type mt-2 rounded px-2 py-1.5 text-[11px]">
                  {toast.solution}
                </div>
              )}
            </div>
            <button
              onClick={handleDismiss}
              aria-label="Dismiss"
              className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
            >
              ×
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Regular toast for simple messages and success
  return (
    <div className="pointer-events-none absolute right-[15px] bottom-full left-[15px] z-[1000] mb-2 [&>*]:pointer-events-auto">
      <div
        role={toast.type === "error" ? "alert" : "status"}
        aria-live={toast.type === "error" ? "assertive" : "polite"}
        className={cn(
          "px-3 py-1.5 rounded text-xs flex items-center gap-1.5 shadow-[0_4px_12px_rgba(0,0,0,0.3)]",
          isLeaving
            ? "animate-[toastFadeOut_0.2s_ease-out_forwards]"
            : "animate-[toastSlideIn_0.2s_ease-out]",
          toastTypeStyles[toast.type]
        )}
      >
        <span className="text-sm leading-none">{toast.type === "success" ? "✓" : "⚠"}</span>
        <div className="flex-1">
          {toast.title && <div className="mb-px text-[11px] font-semibold">{toast.title}</div>}
          <div className="opacity-90">{toast.message}</div>
        </div>
        {toast.type === "error" && (
          <button
            onClick={handleDismiss}
            aria-label="Dismiss"
            className="flex h-4 w-4 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-base leading-none text-inherit opacity-60 transition-opacity hover:opacity-100"
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
};
