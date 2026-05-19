import type { ExtensionDiagnostic, RootKind } from "./manifestValidator";

export interface CandidateContribution {
  type: string;
  id: string;
}

export interface CandidateExtension {
  extensionId: string;
  rootId: string;
  rootKind: RootKind;
  /** Bundled-only flag. A Core Extension's contributions cannot be shadowed. */
  isCore?: boolean;
  contributions: CandidateContribution[];
}

export interface AvailableContribution {
  type: string;
  id: string;
  extensionId: string;
  rootId: string;
  rootKind: RootKind;
}

export interface ResolveConflictsInput {
  candidates: readonly CandidateExtension[];
  /** Override the diagnostic timestamp for deterministic tests. */
  now?: number;
}

export interface ResolveConflictsResult {
  availableContributions: AvailableContribution[];
  diagnostics: ExtensionDiagnostic[];
}

// Core Extension contributions cannot be shadowed; otherwise project-local
// outranks user-global, and user-global outranks non-core bundled.
function precedenceScore(c: CandidateExtension): number {
  if (c.rootKind === "bundled" && c.isCore) return 4;
  if (c.rootKind === "project-local") return 3;
  if (c.rootKind === "user-global") return 2;
  return 1;
}

function uniqueRootList(group: readonly CandidateExtension[]): string {
  return Array.from(new Set(group.map((c) => c.rootKind))).join(", ");
}

function projectScopeKey(candidate: { rootId: string; rootKind: RootKind }): string {
  return candidate.rootKind === "project-local" ? `project:${candidate.rootId}` : "global";
}

function splitByProjectScope<T>(
  group: readonly T[],
  getCandidate: (item: T) => { rootId: string; rootKind: RootKind }
): T[][] {
  const byScope = new Map<string, T[]>();
  for (const item of group) {
    const key = projectScopeKey(getCandidate(item));
    const list = byScope.get(key) ?? [];
    list.push(item);
    byScope.set(key, list);
  }
  return Array.from(byScope.values());
}

export function resolveConflicts(input: ResolveConflictsInput): ResolveConflictsResult {
  const occurredAt = input.now ?? Date.now();
  const diagnostics: ExtensionDiagnostic[] = [];

  const byExtensionId = new Map<string, CandidateExtension[]>();
  for (const c of input.candidates) {
    const list = byExtensionId.get(c.extensionId) ?? [];
    list.push(c);
    byExtensionId.set(c.extensionId, list);
  }

  // Survivors of the Extension Identity Conflict pass; their contributions
  // proceed to contribution-level resolution. Losers' contributions are dropped.
  const survivors: CandidateExtension[] = [];
  for (const [extensionId, group] of byExtensionId) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    const hasCore = group.some((candidate) => candidate.rootKind === "bundled" && candidate.isCore);
    const identityGroups = hasCore ? [group] : splitByProjectScope(group, (candidate) => candidate);
    for (const identityGroup of identityGroups) {
      if (identityGroup.length === 1) {
        survivors.push(identityGroup[0]);
        continue;
      }
      const roots = uniqueRootList(identityGroup);
      // One diagnostic per affected candidate so the per-card surfacing path can
      // attach it to each conflicting Extension; the message names every involved
      // root so the user can resolve without expanding cards.
      for (const c of identityGroup) {
        diagnostics.push({
          code: "extension.identity.conflict",
          severity: "error",
          message: `Extension identity "${extensionId}" from ${c.rootKind} conflicts with claims from: ${roots}.`,
          rootId: c.rootId,
          extensionId,
          occurredAt,
        });
      }
      // Highest precedence wins; a tie at the top drops every conflicting
      // candidate so neither side silently shadows the other.
      const top = Math.max(...identityGroup.map(precedenceScore));
      const winners = identityGroup.filter((c) => precedenceScore(c) === top);
      if (winners.length === 1) {
        survivors.push(winners[0]);
      }
    }
  }

  // Contribution Identity scope is per-type, so `skills/foo` and `agents/foo`
  // do not collide; the key embeds both. The "::" separator is unreachable
  // by the kebab-case ContributionIdSchema so it cannot occur inside a real id.
  interface Owned {
    contribution: CandidateContribution;
    owner: CandidateExtension;
  }
  const byContributionKey = new Map<string, Owned[]>();
  for (const owner of survivors) {
    for (const contribution of owner.contributions) {
      const key = `${contribution.type}::${contribution.id}`;
      const list = byContributionKey.get(key) ?? [];
      list.push({ contribution, owner });
      byContributionKey.set(key, list);
    }
  }

  function toAvailable({ contribution, owner }: Owned): AvailableContribution {
    return {
      type: contribution.type,
      id: contribution.id,
      extensionId: owner.extensionId,
      rootId: owner.rootId,
      rootKind: owner.rootKind,
    };
  }

  const availableContributions: AvailableContribution[] = [];
  for (const group of byContributionKey.values()) {
    const hasCore = group.some((item) => item.owner.rootKind === "bundled" && item.owner.isCore);
    const contributionGroups = hasCore ? [group] : splitByProjectScope(group, (item) => item.owner);

    for (const contributionGroup of contributionGroups) {
      if (contributionGroup.length === 1) {
        availableContributions.push(toAvailable(contributionGroup[0]));
        continue;
      }
      const { type, id } = contributionGroup[0].contribution;
      const claimants = contributionGroup
        .map((g) => `${g.owner.extensionId}@${g.owner.rootKind}`)
        .join(", ");
      for (const { owner } of contributionGroup) {
        diagnostics.push({
          code: "contribution.identity.conflict",
          severity: "warn",
          message: `Contribution "${type}/${id}" claimed by multiple Extensions: ${claimants}.`,
          rootId: owner.rootId,
          extensionId: owner.extensionId,
          contributionRef: { type, id },
          occurredAt,
        });
      }
      const top = Math.max(...contributionGroup.map((g) => precedenceScore(g.owner)));
      const winners = contributionGroup.filter((g) => precedenceScore(g.owner) === top);
      if (winners.length === 1) {
        availableContributions.push(toAvailable(winners[0]));
      }
    }
  }

  return { availableContributions, diagnostics };
}
