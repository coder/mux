import { describe, expect, test } from "bun:test";
import { DriftStatusSchema } from "@/common/orpc/schemas/extensionRegistry";
import {
  calculatePermissions,
  hashRequestedPermissions,
  requiresReapproval,
  type CalculatePermissionsInput,
  type ContributionPermissionRequirement,
  type ApprovalRecord,
} from "./permissionCalculator";

const SKILL_CONTRIB: ContributionPermissionRequirement = {
  type: "skills",
  id: "my-skill",
  registrationPermission: "skill.register",
};

const AGENT_CONTRIB: ContributionPermissionRequirement = {
  type: "agents",
  id: "my-agent",
  registrationPermission: "agent.register",
};

function manifest(overrides: Partial<NonNullable<CalculatePermissionsInput["manifest"]>> = {}) {
  return {
    requestedPermissions: ["skill.register"],
    contributions: [SKILL_CONTRIB],
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const requestedPermissions = ["skill.register"];
  return {
    grantedPermissions: ["skill.register"],
    requestedPermissionsHash: hashRequestedPermissions(requestedPermissions),
    ...overrides,
  };
}

describe("hashRequestedPermissions", () => {
  test("is order-independent and dedup-stable", () => {
    expect(hashRequestedPermissions(["a", "b", "c"])).toBe(
      hashRequestedPermissions(["c", "b", "a"])
    );
    expect(hashRequestedPermissions(["a", "a", "b"])).toBe(hashRequestedPermissions(["a", "b"]));
  });

  test("differs when the underlying set differs", () => {
    expect(hashRequestedPermissions(["a", "b"])).not.toBe(hashRequestedPermissions(["a", "c"]));
  });
});

describe("calculatePermissions — fresh state", () => {
  test("no approval record yields driftStatus 'fresh' and auto-approved registration permissions", () => {
    const result = calculatePermissions({ manifest: manifest() });
    expect(result.driftStatus).toBe("fresh");
    expect(result.effectivePermissions).toEqual(["skill.register"]);
    expect(result.pendingNew).toEqual([]);
    expect(result.isStale).toBe(false);
  });

  test("fresh state marks registration-only contributions available", () => {
    const result = calculatePermissions({ manifest: manifest() });
    expect(result.contributions).toEqual([
      {
        type: "skills",
        id: "my-skill",
        available: true,
        missingPermissions: [],
      },
    ]);
  });
});

describe("calculatePermissions — aligned approval record", () => {
  test("matching approval record yields no drift, full effective permissions, available contributions", () => {
    const result = calculatePermissions({ manifest: manifest(), approvalRecord: approval() });
    expect(result.driftStatus).toBeNull();
    expect(result.effectivePermissions).toEqual(["skill.register"]);
    expect(result.pendingNew).toEqual([]);
    expect(result.contributions[0]).toMatchObject({ id: "my-skill", available: true });
    expect(result.contributions[0].missingPermissions).toEqual([]);
  });

  test("Effective Permissions are strictly the intersection of requested and granted", () => {
    // Granted superset (e.g. user previously granted operational `network` that
    // the new manifest no longer requests) — effective is the intersection.
    const result = calculatePermissions({
      manifest: manifest({ requestedPermissions: ["skill.register"] }),
      approvalRecord: approval({ grantedPermissions: ["skill.register", "network"] }),
    });
    expect(result.effectivePermissions).toEqual(["skill.register"]);
    expect(result.effectivePermissions).not.toContain("network");
  });
});

describe("calculatePermissions — drift transitions", () => {
  test("registration-only contribution additions are auto-approved", () => {
    const result = calculatePermissions({
      manifest: manifest({
        requestedPermissions: ["skill.register", "agent.register"],
        contributions: [SKILL_CONTRIB, AGENT_CONTRIB],
      }),
      approvalRecord: approval(),
    });
    expect(result.driftStatus).toBeNull();
    expect(result.pendingNew).toEqual([]);
    expect(result.effectivePermissions).toEqual(["skill.register", "agent.register"]);
    const agent = result.contributions.find((c) => c.id === "my-agent");
    expect(agent?.available).toBe(true);
    expect(agent?.missingPermissions).toEqual([]);
    const skill = result.contributions.find((c) => c.id === "my-skill");
    expect(skill?.available).toBe(true);
  });

  test("requested capability changes still drift", () => {
    const result = calculatePermissions({
      manifest: manifest({
        requestedPermissions: ["skill.register", "network"],
      }),
      approvalRecord: approval(),
    });
    expect(result.driftStatus).toBe("permissions-changed");
    expect(result.pendingNew).toEqual(["network"]);
  });
});

describe("DriftStatusSchema", () => {
  test("accepts only capability-approval states, not source identity drift states", () => {
    expect(DriftStatusSchema.safeParse("fresh").success).toBe(true);
    expect(DriftStatusSchema.safeParse("permissions-changed").success).toBe(true);
    expect(DriftStatusSchema.safeParse("version-changed").success).toBe(false);
    expect(DriftStatusSchema.safeParse("package-renamed").success).toBe(false);
  });
});

describe("requiresReapproval", () => {
  test("ignores first-time approvals", () => {
    expect(requiresReapproval(calculatePermissions({ manifest: manifest() }))).toBe(false);
  });

  test("requires consent for requested capability drift only", () => {
    expect(
      requiresReapproval(
        calculatePermissions({
          manifest: manifest({ requestedPermissions: ["skill.register", "network"] }),
          approvalRecord: approval(),
        })
      )
    ).toBe(true);
  });
});

describe("calculatePermissions — vanished extension", () => {
  test("approval record with no current manifest yields isStale and no contributions", () => {
    const result = calculatePermissions({ approvalRecord: approval() });
    expect(result.isStale).toBe(true);
    expect(result.contributions).toEqual([]);
    expect(result.effectivePermissions).toEqual([]);
    expect(result.pendingNew).toEqual([]);
    expect(result.driftStatus).toBeNull();
  });
});

describe("calculatePermissions — descriptor-version evolution", () => {
  test("same Extension Identity, same permissions, updated descriptor version reports no drift", () => {
    // Manifest Validator collapses descriptorVersion bumps into the same
    // requested-permission set (registration perms are inferred from
    // contribution *types*, not descriptor versions). Permission Calculator
    // therefore should see no drift across a pure descriptor-version evolution.
    const result = calculatePermissions({
      manifest: manifest({
        // Same contribution type list, same permissions; the per-contribution
        // descriptor version evolution is invisible here.
        requestedPermissions: ["skill.register"],
        contributions: [SKILL_CONTRIB],
      }),
      approvalRecord: approval(),
    });
    expect(result.driftStatus).toBeNull();
    expect(result.pendingNew).toEqual([]);
  });
});

describe("calculatePermissions — new contribution type registration", () => {
  test("adding a new contribution type auto-approves its register permission", () => {
    const result = calculatePermissions({
      manifest: manifest({
        requestedPermissions: ["skill.register", "agent.register"],
        contributions: [SKILL_CONTRIB, AGENT_CONTRIB],
      }),
      approvalRecord: approval(),
    });
    expect(result.pendingNew).not.toContain("agent.register");
    expect(result.effectivePermissions).toContain("agent.register");
    const agent = result.contributions.find((c) => c.id === "my-agent");
    expect(agent?.available).toBe(true);
  });
});

describe("calculatePermissions — contribution-level operational permissions", () => {
  test("contribution stays unavailable until BOTH registration and contribution-level operational perms are effective", () => {
    const networkySkill: ContributionPermissionRequirement = {
      ...SKILL_CONTRIB,
      usesPermissions: ["network"],
    };
    const result = calculatePermissions({
      manifest: manifest({
        requestedPermissions: ["skill.register", "network"],
        contributions: [networkySkill],
      }),
      approvalRecord: approval({
        grantedPermissions: ["skill.register"],
        requestedPermissionsHash: hashRequestedPermissions(["skill.register", "network"]),
      }),
    });
    // Approved hash matches current request, so no drift — but `network` was
    // never actually granted, so the contribution stays unavailable.
    const skill = result.contributions[0];
    expect(skill.available).toBe(false);
    expect(skill.missingPermissions).toEqual(["network"]);
  });

  test("contribution becomes available once both registration and operational perms are granted", () => {
    const networkySkill: ContributionPermissionRequirement = {
      ...SKILL_CONTRIB,
      usesPermissions: ["network"],
    };
    const requested = ["skill.register", "network"];
    const result = calculatePermissions({
      manifest: manifest({
        requestedPermissions: requested,
        contributions: [networkySkill],
      }),
      approvalRecord: approval({
        grantedPermissions: ["skill.register", "network"],
        requestedPermissionsHash: hashRequestedPermissions(requested),
      }),
    });
    expect(result.contributions[0].available).toBe(true);
    expect(result.contributions[0].missingPermissions).toEqual([]);
  });
});
