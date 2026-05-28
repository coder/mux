import { useEffect, useRef } from "react";
import { CheckCircle2, ShieldCheck, X } from "lucide-react";
import type { z } from "zod";

import { trapTabKey } from "./dialogFocus";
import { Button } from "@/browser/components/Button/Button";
import type * as schemas from "@/common/orpc/schemas/extensionRegistry";

type DiscoveredExtension = z.infer<typeof schemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<typeof schemas.CalculatePermissionsResultSchema>;

export interface ConsentShortcutModalProps {
  isOpen: boolean;
  extension: DiscoveredExtension | null;
  permissions: CalculatePermissionsResult | null;
  /**
   * When true, the modal lists "Trust the project-local root" as part of the
   * single confirmation transaction. Reserved for project-local roots whose
   * trust state must be approved in the same step (per spec).
   */
  requiresTrustRoot: boolean;
  onConfirm: () => void;
  onReviewIndividually: () => void;
  onClose: () => void;
}

// Registration Capabilities are mechanical (`<type>.register`); the summary
// highlights effect capabilities because those are the security-relevant
// approvals the user is granting.
function partitionCapabilities(capabilities: readonly string[]): {
  registration: string[];
  effect: string[];
} {
  const registration: string[] = [];
  const effect: string[] = [];
  for (const capability of capabilities) {
    if (capability.endsWith(".register")) registration.push(capability);
    else effect.push(capability);
  }
  return { registration, effect };
}

export const ConsentShortcutModal: React.FC<ConsentShortcutModalProps> = ({
  isOpen,
  extension,
  permissions,
  requiresTrustRoot,
  onConfirm,
  onReviewIndividually,
  onClose,
}) => {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    confirmButtonRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen || !extension) return null;

  const displayName = extension.manifest.displayName ?? extension.manifest.id;
  const { effect, registration } = partitionCapabilities(extension.manifest.requestedPermissions);
  const contributions = extension.manifest.contributions;
  const hasPendingNew = (permissions?.pendingNew.length ?? 0) > 0;

  return (
    <div
      role="dialog"
      aria-labelledby="consent-shortcut-title"
      data-testid="consent-shortcut-modal"
      className="fixed inset-0 z-[1500] flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Close consent shortcut"
        className="bg-foreground/40 absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        onKeyDown={(event) => trapTabKey(panelRef.current, event)}
        className="bg-background-secondary border-border-medium relative z-10 max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-lg border shadow-lg"
      >
        <div className="border-border-light flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 id="consent-shortcut-title" className="text-foreground text-base font-semibold">
              Set up {displayName}
            </h2>
            <p className="text-muted mt-0.5 truncate font-mono text-xs">{extension.manifest.id}</p>
          </div>
          <button
            type="button"
            aria-label="Dismiss consent shortcut"
            onClick={onClose}
            className="text-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-4 py-4">
          <p className="text-foreground text-xs">
            Confirming will apply the following changes in sequence:
          </p>

          <ul className="space-y-1.5 text-xs">
            {requiresTrustRoot && (
              <li className="flex items-start gap-2">
                <CheckCircle2 className="text-accent mt-0.5 h-3 w-3 shrink-0" />
                <span className="text-foreground">Trust the project-local Extensions root.</span>
              </li>
            )}
            <li className="flex items-start gap-2">
              <CheckCircle2 className="text-accent mt-0.5 h-3 w-3 shrink-0" />
              <span className="text-foreground">Enable this Extension.</span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="text-accent mt-0.5 h-3 w-3 shrink-0" />
              <span className="text-foreground">
                Approve the requested capabilities.
                {hasPendingNew && (
                  <span className="text-muted ml-1">
                    ({permissions?.pendingNew.length} pending)
                  </span>
                )}
              </span>
            </li>
          </ul>

          <section>
            <h3 className="text-foreground mb-1 text-[11px] font-semibold tracking-wide uppercase">
              Effect Capabilities ({effect.length})
            </h3>
            {effect.length === 0 ? (
              <p className="text-muted text-xs">None requested.</p>
            ) : (
              <ul className="space-y-1">
                {effect.map((capability) => (
                  <li
                    key={capability}
                    className="border-border-light text-foreground rounded border px-2 py-1 font-mono text-xs break-all"
                  >
                    {capability}
                  </li>
                ))}
              </ul>
            )}
            {registration.length > 0 && (
              <p className="text-muted mt-1 text-[11px]">
                Plus {registration.length} registration capability
                {registration.length === 1 ? "" : "s"} from declared contributions.
              </p>
            )}
          </section>

          <section>
            <h3 className="text-foreground mb-1 text-[11px] font-semibold tracking-wide uppercase">
              Contributions ({contributions.length})
            </h3>
            {contributions.length === 0 ? (
              <p className="text-muted text-xs">None declared.</p>
            ) : (
              <ul className="space-y-1">
                {contributions.map((c) => (
                  <li
                    key={`${c.type}/${c.id}`}
                    className="text-foreground font-mono text-xs break-all"
                  >
                    <span className="text-muted">{c.type}</span>
                    <span className="text-muted">/</span>
                    {c.id}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="border-border-light flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
          <button
            type="button"
            onClick={onReviewIndividually}
            className="text-accent text-xs hover:underline"
            data-testid="consent-shortcut-review-individually"
          >
            Review individually
          </button>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onClose} aria-label="Cancel consent">
              Cancel
            </Button>
            <Button
              ref={confirmButtonRef}
              variant="default"
              size="sm"
              onClick={onConfirm}
              aria-label="Confirm consent shortcut"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              Confirm
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
