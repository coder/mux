import { useCallback, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDownCircle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { z } from "zod";

import { Button } from "@/browser/components/Button/Button";
import { useCopyToClipboard } from "@/browser/hooks/useCopyToClipboard";
import { requiresReapproval } from "@/common/extensions/approvalDrift";
import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";

type DiscoveredExtension = z.infer<typeof extensionRegistrySchemas.DiscoveredExtensionSchema>;
type CalculatePermissionsResult = z.infer<
  typeof extensionRegistrySchemas.CalculatePermissionsResultSchema
>;
type InspectionDescriptor = z.infer<typeof extensionRegistrySchemas.InspectionDescriptorSchema>;
type StaleRecord = z.infer<typeof extensionRegistrySchemas.StaleRecordSchema>;
type ExtensionDiagnostic = z.infer<typeof extensionRegistrySchemas.ExtensionDiagnosticSchema>;

// v1 contribution support level by type. Skills are capability-consumed;
// the rest stay inspection-only until a consumer is wired.
const AVAILABLE_TYPES = new Set(["skills"]);

export type ExtensionStatus =
  | "conflict"
  | "pending-reapproval"
  | "blocked"
  | "inspection-only"
  | "enabled"
  | "disabled";

const STATUS_LABEL: Record<ExtensionStatus, string> = {
  conflict: "Conflict",
  "pending-reapproval": "Pending re-approval",
  blocked: "Blocked",
  "inspection-only": "Inspection only",
  enabled: "Enabled",
  disabled: "Disabled",
};

const CONFLICT_CODES = new Set(["extension.identity.conflict", "contribution.identity.conflict"]);

const BLOCKING_CODES = new Set([
  "manifest.invalid",
  "manifest.version.unsupported",
  "manifest.contributes.unknown_key",
  "extension.identity.invalid",
  "extension.identity.reserved",
]);

export function getExtensionCardTestId(
  extension: Pick<DiscoveredExtension, "rootId" | "extensionId">
): string {
  return `extension-card-${encodeURIComponent(extension.rootId)}-${encodeURIComponent(extension.extensionId)}`;
}

interface ComputeStatusInput {
  extension: DiscoveredExtension;
  permissions: CalculatePermissionsResult | null;
  inspectionOnly: boolean;
}

function hasConflict(extension: DiscoveredExtension): boolean {
  return extension.diagnostics.some((d) => CONFLICT_CODES.has(d.code));
}

function hasBlockingError(extension: DiscoveredExtension): boolean {
  return extension.diagnostics.some((d) => d.severity === "error" && BLOCKING_CODES.has(d.code));
}

export function computeExtensionStatus({
  extension,
  permissions,
  inspectionOnly,
}: ComputeStatusInput): ExtensionStatus {
  // Priority order: Conflict > Pending re-approval > Blocked > Inspection only > Enabled.
  if (hasConflict(extension)) return "conflict";
  if (requiresReapproval(permissions)) return "pending-reapproval";
  if (hasBlockingError(extension)) return "blocked";
  if (inspectionOnly) return "inspection-only";
  if (!extension.enabled) return "disabled";
  return "enabled";
}

interface StatusPillProps {
  status: ExtensionStatus;
}

const STATUS_PILL_CLASS: Record<ExtensionStatus, string> = {
  conflict: "bg-error/15 text-error border-error/40",
  "pending-reapproval": "bg-warning/15 text-warning border-warning/40",
  blocked: "bg-error/15 text-error border-error/40",
  "inspection-only": "bg-background-tertiary text-muted border-border-medium",
  enabled: "bg-accent/15 text-accent border-accent/40",
  disabled: "bg-background-tertiary text-muted border-border-medium",
};

const STATUS_ICON: Record<ExtensionStatus, React.ComponentType<{ className?: string }>> = {
  conflict: ShieldAlert,
  "pending-reapproval": ShieldAlert,
  blocked: Ban,
  "inspection-only": Eye,
  enabled: CheckCircle2,
  disabled: XCircle,
};

const StatusPill: React.FC<StatusPillProps> = ({ status }) => {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase ${STATUS_PILL_CLASS[status]}`}
      data-status={status}
      aria-label={`Status: ${STATUS_LABEL[status]}`}
    >
      <Icon className="h-3 w-3" />
      {STATUS_LABEL[status]}
    </span>
  );
};

interface DiagnosticListProps {
  diagnostics: readonly ExtensionDiagnostic[];
}

const SEVERITY_ICON: Record<
  ExtensionDiagnostic["severity"],
  React.ComponentType<{ className?: string }>
> = {
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
};

const SEVERITY_COLOR: Record<ExtensionDiagnostic["severity"], string> = {
  error: "text-error",
  warn: "text-warning",
  info: "text-muted",
};

const DiagnosticList: React.FC<DiagnosticListProps> = ({ diagnostics }) => {
  if (diagnostics.length === 0) {
    return <p className="text-muted text-xs">No diagnostics.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {diagnostics.map((d, idx) => {
        const Icon = SEVERITY_ICON[d.severity];
        return (
          <li key={`${d.code}:${idx}`} className="flex items-start gap-2 text-xs">
            <Icon className={`mt-0.5 h-3 w-3 shrink-0 ${SEVERITY_COLOR[d.severity]}`} />
            <div className="min-w-0">
              <div className="text-foreground break-words">
                <span className="font-mono text-[11px]">{d.code}</span>
                {d.contributionRef && (
                  <span className="text-muted ml-2 font-mono text-[11px]">
                    {d.contributionRef.type}
                    {d.contributionRef.id ? `/${d.contributionRef.id}` : ""}
                  </span>
                )}
              </div>
              <div className="text-muted mt-0.5 break-words">{d.message}</div>
              {d.suggestedAction && (
                <div className="text-muted mt-0.5 break-words italic">{d.suggestedAction}</div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
};

interface ContributionsTableProps {
  extension: DiscoveredExtension;
  availabilityById: ReadonlyMap<string, { available: boolean; missingPermissions: string[] }>;
  descriptorById: ReadonlyMap<string, InspectionDescriptor>;
}

const ContributionsTable: React.FC<ContributionsTableProps> = ({
  extension,
  availabilityById,
  descriptorById,
}) => {
  if (extension.manifest.contributions.length === 0) {
    return <p className="text-muted text-xs">No contributions declared.</p>;
  }
  const extensionConflicted = extension.diagnostics.some(
    (d) => d.code === "extension.identity.conflict"
  );
  const conflictRefs = new Set(
    extension.diagnostics
      .filter((d) => d.code === "contribution.identity.conflict" && d.contributionRef)
      .map((d) => `${d.contributionRef!.type}/${d.contributionRef!.id ?? ""}`)
  );
  const activatedRefs = new Map<string, boolean>(
    extension.contributions.map((c) => [`${c.type}/${c.id}`, c.activated])
  );
  return (
    <div className="border-border-light overflow-hidden rounded-md border">
      <table className="w-full text-left text-xs">
        <thead className="bg-background-secondary text-muted">
          <tr>
            <th className="px-2 py-1.5 font-medium">Type</th>
            <th className="px-2 py-1.5 font-medium">ID</th>
            <th className="px-2 py-1.5 font-medium">Support</th>
            <th className="px-2 py-1.5 font-medium">Availability</th>
            <th className="px-2 py-1.5 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {extension.manifest.contributions.map((c) => {
            const availability = availabilityById.get(`${c.type}/${c.id}`);
            const isAvailableType = AVAILABLE_TYPES.has(c.type);
            const supportLevel = isAvailableType ? "Available" : "Inspection only";
            const conflictKey = `${c.type}/${c.id}`;
            const descriptor = descriptorById.get(conflictKey);
            const descriptorConflicted =
              descriptor?.unavailableReasons.includes("conflict") === true;
            const conflicted = descriptor
              ? descriptorConflicted
              : extensionConflicted || conflictRefs.has(conflictKey);
            const activationKnown = activatedRefs.get(conflictKey);
            // Resolver descriptors are the source of truth when present: they distinguish
            // winning conflicts from losing conflicts and include body-failed contributions.
            const contributionActivated = extension.activated && (activationKnown ?? true);
            const contributionAvailable = descriptor
              ? descriptor.available
              : availability?.available === true && contributionActivated && !conflicted;
            const missingPermissions =
              descriptor?.missingPermissions ?? availability?.missingPermissions ?? [];
            return (
              <tr key={conflictKey} className="border-border-light border-t">
                <td className="px-2 py-1.5 font-mono">{c.type}</td>
                <td className="px-2 py-1.5 font-mono">{c.id}</td>
                <td className="px-2 py-1.5">
                  <span className={isAvailableType ? "text-foreground" : "text-muted italic"}>
                    {supportLevel}
                  </span>
                </td>
                <td className="px-2 py-1.5">
                  {!isAvailableType || availability == null ? (
                    <span className="text-muted">—</span>
                  ) : contributionAvailable ? (
                    <span className="text-accent inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      Available
                    </span>
                  ) : missingPermissions.length > 0 ? (
                    <span className="text-warning inline-flex items-center gap-1">
                      <Lock className="h-3 w-3" />
                      Missing
                      <span className="text-muted ml-1 font-mono text-[10px]">
                        ({missingPermissions.join(", ")})
                      </span>
                    </span>
                  ) : (
                    <span className="text-warning inline-flex items-center gap-1">
                      <Ban className="h-3 w-3" />
                      Unavailable
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {conflicted ? (
                    <span className="text-error inline-flex items-center gap-1">
                      <ShieldAlert className="h-3 w-3" />
                      Conflict
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};

interface CapabilitiesBlockProps {
  extension: DiscoveredExtension;
  permissions: CalculatePermissionsResult | null;
}

// Registration Capabilities are the `<type>.register` entries generated from
// discovered contributions; everything else in `requestedPermissions` is an
// Effect Capability. We separate them so users can collapse the mechanical
// registration block and review effect capabilities in detail.
function partitionCapabilities(extension: DiscoveredExtension): {
  registration: string[];
  effect: string[];
} {
  const registration: string[] = [];
  const effect: string[] = [];
  for (const capability of extension.manifest.requestedPermissions) {
    if (capability.endsWith(".register")) registration.push(capability);
    else effect.push(capability);
  }
  return { registration, effect };
}

type EffectCapabilityState = "approved" | "pending-new" | "revoked";

function effectCapabilityStateFor(
  capability: string,
  permissions: CalculatePermissionsResult | null
): EffectCapabilityState {
  if (!permissions) return "pending-new";
  if (permissions.effectivePermissions.includes(capability)) return "approved";
  if (permissions.pendingNew.includes(capability)) return "pending-new";
  return "revoked";
}

const CAPABILITY_STATE_LABEL: Record<EffectCapabilityState, string> = {
  approved: "Approved",
  "pending-new": "Pending",
  revoked: "Revoked",
};

const CAPABILITY_STATE_CLASS: Record<EffectCapabilityState, string> = {
  approved: "text-accent",
  "pending-new": "text-warning",
  revoked: "text-muted line-through",
};

const CapabilitiesBlock: React.FC<CapabilitiesBlockProps> = ({ extension, permissions }) => {
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const { registration, effect } = useMemo(() => partitionCapabilities(extension), [extension]);

  return (
    <div className="space-y-3">
      <div className="border-border-light overflow-hidden rounded-md border">
        <button
          type="button"
          onClick={() => setRegistrationOpen((v) => !v)}
          className="bg-background-secondary text-foreground hover:text-accent flex w-full items-center justify-between gap-2 px-3 py-2 text-xs"
          aria-expanded={registrationOpen}
        >
          <span className="flex items-center gap-1.5">
            {registrationOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            Registration Capabilities ({registration.length})
          </span>
          <a
            href="https://mux.coder.com/extensions/authoring#capabilities"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Why?
          </a>
        </button>
        {registrationOpen && (
          <div className="space-y-1 px-3 py-2">
            {registration.length === 0 ? (
              <p className="text-muted text-xs">No registration capabilities.</p>
            ) : (
              <ul className="space-y-1">
                {registration.map((capability) => (
                  <li key={capability} className="text-foreground font-mono text-xs">
                    {capability}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div>
        <h4 className="text-foreground mb-1.5 text-xs font-medium">
          Effect Capabilities ({effect.length})
        </h4>
        {effect.length === 0 ? (
          <p className="text-muted text-xs">No effect capabilities requested.</p>
        ) : (
          <ul className="space-y-1">
            {effect.map((capability) => {
              const state = effectCapabilityStateFor(capability, permissions);
              return (
                <li
                  key={capability}
                  className="border-border-light flex items-center justify-between gap-3 rounded border px-2 py-1 text-xs"
                >
                  <span className="text-foreground font-mono break-all">{capability}</span>
                  <span
                    className={`shrink-0 text-[10px] uppercase ${CAPABILITY_STATE_CLASS[state]}`}
                  >
                    {CAPABILITY_STATE_LABEL[state]}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

interface IdentityBlockProps {
  extension: DiscoveredExtension;
}

const IdentityBlock: React.FC<IdentityBlockProps> = ({ extension }) => {
  const { copied, copyToClipboard } = useCopyToClipboard();
  return (
    <dl className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-2">
        <dt className="text-muted w-32 shrink-0">Extension Name</dt>
        <dd className="text-foreground font-mono break-all">{extension.manifest.id}</dd>
      </div>
      <div className="flex flex-wrap items-baseline gap-2">
        <dt className="text-muted w-32 shrink-0">Module Path</dt>
        <dd className="text-foreground font-mono break-all">
          {extension.modulePath}
          <button
            type="button"
            onClick={() => void copyToClipboard(extension.modulePath)}
            className="text-muted hover:text-accent ml-2 align-middle"
            aria-label="Copy module path"
          >
            <Copy className="inline h-3 w-3" />
          </button>
          {copied && <span className="text-muted ml-1 text-[10px]">copied</span>}
        </dd>
      </div>
      {extension.manifest.publisher && (
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="text-muted w-32 shrink-0">Publisher</dt>
          <dd className="text-foreground break-all">{extension.manifest.publisher}</dd>
        </div>
      )}
      {extension.manifest.homepage && (
        <div className="flex flex-wrap items-baseline gap-2">
          <dt className="text-muted w-32 shrink-0">Homepage</dt>
          <dd>
            <a
              href={extension.manifest.homepage}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent break-all hover:underline"
            >
              {extension.manifest.homepage}
            </a>
          </dd>
        </div>
      )}
    </dl>
  );
};

export interface ExtensionCardProps {
  extension: DiscoveredExtension;
  permissions: CalculatePermissionsResult | null;
  inspectionOnly: boolean;
  /**
   * When true, the card is force-expanded regardless of the user's local
   * toggle. The section uses this to auto-open a card after the user clicks
   * "Review individually" inside the Consent Shortcut Modal.
   */
  forceExpanded?: boolean;
  descriptors?: readonly InspectionDescriptor[];
  /**
   * When true, the card carries a visible focus ring used by section-local
   * J/K navigation. The section is the source of truth for which card is
   * focused; the card itself only renders the indicator.
   */
  focused?: boolean;
  onReload: (rootId: string, extensionId: string) => void | Promise<void>;
  onEnable: (rootId: string, extensionId: string) => void | Promise<void>;
  onDisable: (rootId: string, extensionId: string) => void | Promise<void>;
  onGrant: (rootId: string, extensionId: string) => void | Promise<void>;
  onRevoke: (rootId: string, extensionId: string) => void | Promise<void>;
  /**
   * Opens the Consent Shortcut flow for this extension. Provided by the
   * section so trust, enablement, and approval can run as one transaction. Optional so
   * existing callers (and tests) can omit it.
   */
  onQuickSetup?: (rootId: string, extensionId: string) => void;
}

export const ExtensionCard: React.FC<ExtensionCardProps> = ({
  extension,
  permissions,
  inspectionOnly,
  forceExpanded,
  descriptors = [],
  focused,
  onReload,
  onEnable,
  onDisable,
  onGrant,
  onRevoke,
  onQuickSetup,
}) => {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = localExpanded || forceExpanded === true;
  const [busy, setBusy] = useState(false);
  const { copied: pathCopied, copyToClipboard } = useCopyToClipboard();

  const status = computeExtensionStatus({ extension, permissions, inspectionOnly });
  const displayName = extension.manifest.displayName ?? extension.manifest.id;

  const availabilityById = useMemo(() => {
    const map = new Map<string, { available: boolean; missingPermissions: string[] }>();
    if (!permissions) return map;
    for (const c of permissions.contributions) {
      map.set(`${c.type}/${c.id}`, {
        available: c.available,
        missingPermissions: c.missingPermissions,
      });
    }
    return map;
  }, [permissions]);

  const descriptorById = useMemo(() => {
    const map = new Map<string, InspectionDescriptor>();
    for (const descriptor of descriptors) {
      map.set(`${descriptor.type}/${descriptor.id}`, descriptor);
    }
    return map;
  }, [descriptors]);

  const wrapBusy = useCallback(<T,>(fn: () => T | Promise<T>) => {
    void (async () => {
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    })();
  }, []);

  // Three-state approval button per spec: Approve / Re-approve pending / Revoke.
  //   - "fresh" means no approval record exists yet → "Approve".
  //   - capability or source-name drift requires a renewed approval.
  //   - aligned records and source-only updates keep the current approval revocable.
  const policyGranted = extension.rootKind === "bundled";
  const grantButton: "grant" | "reapproval" | "revoke" = (() => {
    if (!permissions || permissions.driftStatus === "fresh") return "grant";
    if (requiresReapproval(permissions)) return "reapproval";
    return "revoke";
  })();

  return (
    <div
      className={`border-border-medium bg-background-secondary overflow-hidden rounded-md border ${
        focused ? "ring-accent ring-2 ring-offset-1" : ""
      }`}
      data-testid={getExtensionCardTestId(extension)}
      data-focused={focused ? "true" : undefined}
    >
      <button
        type="button"
        onClick={() => setLocalExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={`ext-card-body-${extension.extensionId}`}
        className="hover:bg-hover/30 flex w-full items-start justify-between gap-3 px-3 py-2 text-left transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-foreground text-sm font-medium">{displayName}</span>
            <span className="text-muted font-mono text-xs">{extension.manifest.id}</span>
            <StatusPill status={status} />
          </div>
          {extension.manifest.description && (
            <p className="text-muted mt-0.5 truncate text-xs">{extension.manifest.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {expanded ? (
            <ChevronDown className="text-muted h-4 w-4" />
          ) : (
            <ChevronRight className="text-muted h-4 w-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div
          id={`ext-card-body-${extension.extensionId}`}
          className="border-border-light space-y-4 border-t px-3 py-3"
        >
          <section>
            <h3 className="text-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
              Identity
            </h3>
            <IdentityBlock extension={extension} />
          </section>

          <section>
            <h3 className="text-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
              Capabilities
            </h3>
            <CapabilitiesBlock extension={extension} permissions={permissions} />
          </section>

          <section>
            <h3 className="text-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
              Contributions
            </h3>
            <ContributionsTable
              extension={extension}
              availabilityById={availabilityById}
              descriptorById={descriptorById}
            />
          </section>

          <section>
            <h3 className="text-foreground mb-1.5 text-xs font-semibold tracking-wide uppercase">
              Diagnostics
            </h3>
            <DiagnosticList diagnostics={extension.diagnostics} />
            {inspectionOnly && (
              <p className="text-muted mt-2 text-[11px] italic">
                Root is untrusted; this Extension is shown in inspection-only mode and cannot be
                activated.
              </p>
            )}
          </section>

          <section className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void copyToClipboard(extension.modulePath)}
              aria-label="Copy module path"
            >
              <Copy className="h-3.5 w-3.5" />
              {pathCopied ? "Path copied" : "Copy path"}
            </Button>

            <Button
              variant="outline"
              size="sm"
              disabled={busy || inspectionOnly}
              onClick={() => wrapBusy(() => onReload(extension.rootId, extension.extensionId))}
              aria-label="Reload extension"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Reload
            </Button>

            {policyGranted ? (
              <span className="text-muted text-xs">Policy-enabled</span>
            ) : extension.enabled ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || inspectionOnly}
                onClick={() => wrapBusy(() => onDisable(extension.rootId, extension.extensionId))}
                aria-label="Disable extension"
              >
                <Ban className="h-3.5 w-3.5" />
                Disable
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || inspectionOnly}
                onClick={() => wrapBusy(() => onEnable(extension.rootId, extension.extensionId))}
                aria-label="Enable extension"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Enable
              </Button>
            )}

            {policyGranted ? (
              <span className="text-muted text-xs">Policy-approved</span>
            ) : grantButton === "reapproval" ? (
              <Button
                variant="default"
                size="sm"
                disabled={busy || inspectionOnly}
                onClick={() => wrapBusy(() => onGrant(extension.rootId, extension.extensionId))}
                aria-label="Re-approve pending capabilities"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Re-approve pending
              </Button>
            ) : grantButton === "revoke" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || inspectionOnly}
                onClick={() => wrapBusy(() => onRevoke(extension.rootId, extension.extensionId))}
                aria-label="Revoke approval"
              >
                <ArrowDownCircle className="h-3.5 w-3.5" />
                Revoke
              </Button>
            ) : (
              <>
                {onQuickSetup && (
                  <Button
                    variant="default"
                    size="sm"
                    disabled={busy}
                    onClick={() => onQuickSetup(extension.rootId, extension.extensionId)}
                    aria-label="Quick setup with consent shortcut"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Quick setup
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || inspectionOnly}
                  onClick={() => wrapBusy(() => onGrant(extension.rootId, extension.extensionId))}
                  aria-label="Approve capabilities"
                >
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Approve
                </Button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
};

export interface StaleRecordCardProps {
  record: StaleRecord;
  onForget: (rootId: string, extensionId: string) => void | Promise<void>;
  onKeep?: () => void;
}

export const StaleRecordCard: React.FC<StaleRecordCardProps> = ({ record, onForget, onKeep }) => {
  const [busy, setBusy] = useState(false);
  return (
    <div
      className="border-warning/40 bg-warning/5 overflow-hidden rounded-md border"
      data-testid={`stale-record-${record.extensionId}`}
    >
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-foreground text-sm font-medium">{record.extensionId}</span>
          <StatusPill status="blocked" />
          <span className="bg-warning/15 text-warning border-warning/40 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase">
            Stale Approval Record
          </span>
        </div>
        <p className="text-muted mt-1 text-xs">
          An approval record exists but the Extension is no longer present. Forget the record to
          clear its capability approvals, or keep it in case the Extension reappears.
        </p>
      </div>
      <div className="border-border-light flex flex-wrap gap-2 border-t px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                await onForget(record.rootId, record.extensionId);
              } finally {
                setBusy(false);
              }
            })();
          }}
          aria-label="Forget stale record"
        >
          <XCircle className="h-3.5 w-3.5" />
          Forget
        </Button>
        {onKeep && (
          <Button variant="outline" size="sm" onClick={onKeep} aria-label="Keep stale record">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Keep
          </Button>
        )}
      </div>
    </div>
  );
};
