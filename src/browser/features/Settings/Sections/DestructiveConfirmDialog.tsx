import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

import { trapTabKey } from "./dialogFocus";
import { Button } from "@/browser/components/Button/Button";

export interface DestructiveConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  consequences: readonly string[];
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}

export const DestructiveConfirmDialog: React.FC<DestructiveConfirmDialogProps> = ({
  isOpen,
  title,
  description,
  consequences,
  confirmLabel,
  onConfirm,
  onClose,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="alertdialog"
      aria-labelledby="destructive-confirm-title"
      data-testid="destructive-confirm-dialog"
      className="fixed inset-0 z-[1500] flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close confirmation"
        className="bg-foreground/40 absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        onKeyDown={(event) => trapTabKey(panelRef.current, event)}
        className="bg-background-secondary border-border-medium relative z-10 w-full max-w-md rounded-lg border shadow-lg"
      >
        <div className="border-border-light flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
            <h2 id="destructive-confirm-title" className="text-foreground text-base font-semibold">
              {title}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onClose}
            className="text-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          <p className="text-foreground text-xs">{description}</p>
          {consequences.length > 0 && (
            <div>
              <p className="text-muted mb-1 text-[11px] tracking-wide uppercase">Consequences</p>
              <ul className="space-y-1">
                {consequences.map((c, idx) => (
                  <li key={idx} className="text-foreground flex items-start gap-2 text-xs">
                    <span className="text-warning mt-0.5">•</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="border-border-light flex justify-end gap-2 border-t px-4 py-3">
          <Button
            ref={cancelRef}
            variant="outline"
            size="sm"
            onClick={onClose}
            aria-label="Cancel destructive action"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            aria-label={`Confirm: ${confirmLabel}`}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
};
