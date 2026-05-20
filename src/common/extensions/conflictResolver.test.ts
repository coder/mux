import { describe, expect, test } from "bun:test";
import {
  resolveConflicts,
  type CandidateExtension,
  type ResolveConflictsInput,
} from "./conflictResolver";

const FROZEN_NOW = 1_700_000_000_000;

function input(candidates: CandidateExtension[], overrides: Partial<ResolveConflictsInput> = {}) {
  return { candidates, now: FROZEN_NOW, ...overrides };
}

describe("resolveConflicts — no conflicts", () => {
  test("disjoint extensions and contributions all become available with no diagnostics", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "foo-skill" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "project-local",
          rootId: "project-local:/repo",
          contributions: [{ type: "agents", id: "bar-agent" }],
        },
      ])
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.availableContributions).toEqual([
      {
        type: "skills",
        id: "foo-skill",
        extensionId: "publisher.foo",
        rootKind: "user-global",
        rootId: "user-global",
      },
      {
        type: "agents",
        id: "bar-agent",
        extensionId: "publisher.bar",
        rootKind: "project-local",
        rootId: "project-local:/repo",
      },
    ]);
  });
});

describe("resolveConflicts — Extension Identity Conflict", () => {
  test("project-local identity shadowing keeps user-global identity available for other projects", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "global-skill" }],
        },
        {
          extensionId: "publisher.foo",
          rootKind: "project-local",
          rootId: "project-local:/repo",
          contributions: [{ type: "skills", id: "project-skill" }],
        },
      ])
    );

    expect(result.availableContributions.map((c) => `${c.rootId}:${c.id}`).sort()).toEqual([
      "project-local:/repo:project-skill",
      "user-global:global-skill",
    ]);
  });

  test("same extension identity in different project-local roots is scoped per project", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "project-local",
          rootId: "project-local:/repo-a",
          contributions: [{ type: "skills", id: "a" }],
        },
        {
          extensionId: "publisher.foo",
          rootKind: "project-local",
          rootId: "project-local:/repo-b",
          contributions: [{ type: "skills", id: "b" }],
        },
      ])
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.availableContributions.map((c) => `${c.rootId}:${c.id}`).sort()).toEqual([
      "project-local:/repo-a:a",
      "project-local:/repo-b:b",
    ]);
  });

  test("identity tie at the same precedence level yields zero contributions from any candidate", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "a" }],
        },
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "b" }],
        },
      ])
    );
    expect(result.availableContributions).toEqual([]);
    expect(result.diagnostics.filter((d) => d.code === "extension.identity.conflict")).toHaveLength(
      2
    );
  });

  test("Core Extension wins identity conflict over higher-precedence non-core root", () => {
    // Core Extension contributions cannot be shadowed even by a project-local
    // root that would otherwise outrank a bundled root.
    const result = resolveConflicts(
      input([
        {
          extensionId: "mux.platformdemo",
          rootKind: "bundled",
          rootId: "bundled",
          isCore: true,
          contributions: [{ type: "skills", id: "core-skill" }],
        },
        {
          extensionId: "mux.platformdemo",
          rootKind: "project-local",
          rootId: "project-local:/repo",
          contributions: [{ type: "skills", id: "squatter-skill" }],
        },
      ])
    );
    expect(result.availableContributions).toEqual([
      {
        type: "skills",
        id: "core-skill",
        extensionId: "mux.platformdemo",
        rootKind: "bundled",
        rootId: "bundled",
      },
    ]);
    expect(result.diagnostics.filter((d) => d.code === "extension.identity.conflict")).toHaveLength(
      2
    );
  });

  test("non-conflicting extensions still produce their contributions even when others conflict", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "foo-a" }],
        },
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "foo-b" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "bar-a" }],
        },
      ])
    );
    expect(result.availableContributions).toEqual([
      {
        type: "skills",
        id: "bar-a",
        extensionId: "publisher.bar",
        rootKind: "user-global",
        rootId: "user-global",
      },
    ]);
  });
});

describe("resolveConflicts — Contribution Identity Conflict", () => {
  test("user-global and project-local contribution identities resolve in separate project scopes", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "project-local",
          rootId: "project-local:/repo",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
      ])
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.availableContributions.map((c) => `${c.rootId}:${c.id}`).sort()).toEqual([
      "project-local:/repo:shared-skill",
      "user-global:shared-skill",
    ]);
  });

  test("same contribution identity in different project-local roots is scoped per project", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo-a",
          rootKind: "project-local",
          rootId: "project-local:/repo-a",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
        {
          extensionId: "publisher.foo-b",
          rootKind: "project-local",
          rootId: "project-local:/repo-b",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
      ])
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.availableContributions.map((c) => `${c.rootId}:${c.id}`).sort()).toEqual([
      "project-local:/repo-a:shared-skill",
      "project-local:/repo-b:shared-skill",
    ]);
  });

  test("contribution-id collision tied at same precedence drops both contributions", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
      ])
    );
    expect(result.availableContributions).toEqual([]);
    expect(
      result.diagnostics.filter((d) => d.code === "contribution.identity.conflict")
    ).toHaveLength(2);
  });

  test("collision across different contribution types is NOT a conflict (different namespaces)", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "x" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "agents", id: "x" }],
        },
      ])
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.availableContributions).toHaveLength(2);
  });

  test("Core Extension contribution cannot be shadowed by a contribution-id collision from any other root", () => {
    const result = resolveConflicts(
      input([
        {
          extensionId: "mux.platformdemo",
          rootKind: "bundled",
          rootId: "bundled",
          isCore: true,
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
        {
          extensionId: "publisher.squatter",
          rootKind: "project-local",
          rootId: "project-local:/repo",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
      ])
    );
    // Core Extension's contribution survives; squatter's is dropped.
    expect(result.availableContributions).toEqual([
      {
        type: "skills",
        id: "shared-skill",
        extensionId: "mux.platformdemo",
        rootKind: "bundled",
        rootId: "bundled",
      },
    ]);
    expect(
      result.diagnostics.filter((d) => d.code === "contribution.identity.conflict")
    ).toHaveLength(2);
  });

  test("a candidate dropped by extension-identity conflict does not contribute to contribution-id conflicts downstream", () => {
    // publisher.foo at user-global is dropped by the identity conflict; its
    // would-be contribution `shared-skill` therefore must NOT appear in the
    // contribution-id conflict against publisher.bar's `shared-skill`.
    const result = resolveConflicts(
      input([
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
        {
          extensionId: "publisher.foo",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "alt-skill" }],
        },
        {
          extensionId: "publisher.bar",
          rootKind: "user-global",
          rootId: "user-global",
          contributions: [{ type: "skills", id: "shared-skill" }],
        },
      ])
    );
    expect(
      result.diagnostics.filter((d) => d.code === "contribution.identity.conflict")
    ).toHaveLength(0);
    expect(
      result.availableContributions.find(
        (c) => c.id === "shared-skill" && c.extensionId === "publisher.bar"
      )
    ).toBeDefined();
  });
});

describe("resolveConflicts — diagnostic record shape", () => {
  test("every diagnostic carries code, severity, message, and occurredAt", () => {
    const result = resolveConflicts(
      input(
        [
          {
            extensionId: "publisher.foo",
            rootKind: "user-global",
            rootId: "user-global",
            contributions: [{ type: "skills", id: "x" }],
          },
          {
            extensionId: "publisher.foo",
            rootKind: "user-global",
            rootId: "user-global",
            contributions: [{ type: "skills", id: "x" }],
          },
        ],
        { now: 42 }
      )
    );
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const d of result.diagnostics) {
      expect(typeof d.code).toBe("string");
      expect(["error", "warn", "info"]).toContain(d.severity);
      expect(typeof d.message).toBe("string");
      expect(d.occurredAt).toBe(42);
    }
  });
});
