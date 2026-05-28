import crypto from "crypto";

export type DriftStatus = "fresh" | "permissions-changed";

export interface ApprovalRecord {
  grantedPermissions: string[];
  requestedPermissionsHash: string;
}

export interface ContributionPermissionRequirement {
  type: string;
  id: string;
  registrationPermission: string;
  usesPermissions?: string[];
}

export interface CalculatePermissionsInput {
  manifest?: {
    requestedPermissions: string[];
    contributions: ContributionPermissionRequirement[];
  };
  approvalRecord?: ApprovalRecord;
}

export interface ContributionAvailability {
  type: string;
  id: string;
  available: boolean;
  missingPermissions: string[];
}

export interface CalculatePermissionsResult {
  effectivePermissions: string[];
  pendingNew: string[];
  contributions: ContributionAvailability[];
  driftStatus: DriftStatus | null;
  isStale: boolean;
}

// Order-independent and dedup-stable hash of the requested capability set, so
// the approval record stores a single canonical fingerprint regardless of how
// the manifest happens to order its capabilities.
export function hashRequestedPermissions(perms: readonly string[]): string {
  const canonical = Array.from(new Set(perms)).sort().join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function intersect(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return unique(a).filter((p) => set.has(p));
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const set = new Set(b);
  return unique(a).filter((p) => !set.has(p));
}

export function filterEffectPermissions(
  requestedPermissions: readonly string[],
  registrationPermissions: readonly string[]
): string[] {
  const registrationSet = new Set(registrationPermissions);
  return unique(requestedPermissions).filter((permission) => !registrationSet.has(permission));
}

// Capability drift is based only on requested effect capability changes. Source
// identity changes (git ref/content/distribution metadata) and registration-only
// changes must not invalidate existing approvals by themselves.
export { requiresReapproval } from "./approvalDrift";

export function calculatePermissions(input: CalculatePermissionsInput): CalculatePermissionsResult {
  const { manifest, approvalRecord } = input;

  // Vanished extension: an approval record exists but the Extension is no
  // longer present in the current snapshot. Surface as a Stale Approval Record;
  // do not synthesize contributions or drift from a missing manifest.
  if (!manifest) {
    return {
      effectivePermissions: [],
      pendingNew: [],
      contributions: [],
      driftStatus: null,
      isStale: true,
    };
  }

  const requested = manifest.requestedPermissions;
  const registrationPermissions = unique(
    manifest.contributions.map((contribution) => contribution.registrationPermission)
  );
  const effectRequested = filterEffectPermissions(requested, registrationPermissions);
  const granted = approvalRecord?.grantedPermissions ?? [];
  const effectiveSet = new Set([
    ...intersect(requested, registrationPermissions),
    ...intersect(effectRequested, granted),
  ]);
  const effectivePermissions = Array.from(effectiveSet);

  const pendingNew = difference(effectRequested, granted);

  const contributions: ContributionAvailability[] = manifest.contributions.map((c) => {
    const required = [c.registrationPermission, ...(c.usesPermissions ?? [])];
    const missing = required.filter((p) => !effectiveSet.has(p));
    return {
      type: c.type,
      id: c.id,
      available: missing.length === 0,
      missingPermissions: missing,
    };
  });

  let driftStatus: DriftStatus | null;
  if (!approvalRecord) {
    driftStatus = "fresh";
  } else {
    driftStatus = pendingNew.length > 0 ? "permissions-changed" : null;
  }

  return {
    effectivePermissions,
    pendingNew,
    contributions,
    driftStatus,
    isStale: false,
  };
}
