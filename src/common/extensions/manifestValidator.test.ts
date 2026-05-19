import { describe, expect, test } from "bun:test";
import { validateManifest, validateStaticManifest, type RootKind } from "./manifestValidator";

const FROZEN_NOW = 1_700_000_000_000;

function input(overrides: { rawMux?: unknown; pkg?: unknown; rootKind?: RootKind; now?: number }) {
  return {
    rawMux: { manifestVersion: 1, id: "publisher.foo", contributes: {} },
    pkg: { name: "@publisher/mux-foo", version: "0.1.0" },
    rootKind: "user-global" as RootKind,
    now: FROZEN_NOW,
    ...overrides,
  };
}

describe("validateStaticManifest", () => {
  test("accepts static Extension Module manifest matching its folder name", () => {
    const result = validateStaticManifest({
      rawManifest: {
        name: "acme-review",
        displayName: "Acme Review",
        description: "Review helpers",
        capabilities: { skills: true },
      },
      extensionName: "acme-review",
      rootKind: "user-global",
      now: FROZEN_NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest).toMatchObject({
      id: "acme-review",
      displayName: "Acme Review",
      description: "Review helpers",
      requestedPermissions: [],
      contributions: [],
    });
  });

  test("preserves explicit requested permissions from static Extension Module manifest", () => {
    const result = validateStaticManifest({
      rawManifest: {
        name: "acme-review",
        capabilities: { skills: true },
        requestedPermissions: ["network", "network"],
      },
      extensionName: "acme-review",
      rootKind: "user-global",
      now: FROZEN_NOW,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).toEqual(["network"]);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "manifest.unknown_field")
    ).toBe(false);
  });

  test("rejects manifest name mismatch", () => {
    const result = validateStaticManifest({
      rawManifest: { name: "other-review", capabilities: { skills: true } },
      extensionName: "acme-review",
      rootKind: "user-global",
      now: FROZEN_NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({
      code: "extension.name.mismatch",
      severity: "error",
      occurredAt: FROZEN_NOW,
    });
  });

  test("rejects invalid folder names before trusting manifest content", () => {
    const result = validateStaticManifest({
      rawManifest: { name: "acme-review", capabilities: { skills: true } },
      extensionName: "Acme_Review",
      rootKind: "project-local",
      now: FROZEN_NOW,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: "extension.name.invalid" });
  });

  test("rejects unknown capability keys", () => {
    const result = validateStaticManifest({
      rawManifest: { name: "acme-review", capabilities: { skills: true, shell: true } },
      extensionName: "acme-review",
      rootKind: "user-global",
      now: FROZEN_NOW,
    });

    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.code === "manifest.capability.unknown")
    ).toBe(true);
  });
});

describe("validateManifest envelope", () => {
  test("accepts a minimal valid manifest from user-global root", () => {
    const result = validateManifest(input({}));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe("publisher.foo");
    expect(result.manifest.manifestVersion).toBe(1);
    expect(result.manifest.requestedPermissions).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("rejects unknown manifestVersion with manifest.version.unsupported error", () => {
    const result = validateManifest(
      input({ rawMux: { manifestVersion: 2, id: "publisher.foo", contributes: {} } })
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "manifest.version.unsupported",
      severity: "error",
      occurredAt: FROZEN_NOW,
    });
  });

  test("rejects manifest with invalid identity regex", () => {
    const result = validateManifest(
      input({ rawMux: { manifestVersion: 1, id: "NoDots", contributes: {} } })
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "extension.identity.invalid")).toBe(true);
  });

  test("rejects unknown contributes top-level keys with manifest.contributes.unknown_key", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: { widgets: [] },
        },
      })
    );
    expect(result.ok).toBe(false);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain("manifest.contributes.unknown_key");
    const widgetDiag = result.diagnostics.find(
      (d) => d.code === "manifest.contributes.unknown_key"
    );
    expect(widgetDiag?.severity).toBe("error");
    expect(widgetDiag?.message).toContain("widgets");
  });

  test("rejects known contributes keys when the value is not an array", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: { skills: { id: "demo", body: "SKILL.md" } },
        },
      })
    );

    expect(result.ok).toBe(false);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === "manifest.contributes.invalid_list"
    );
    expect(diagnostic).toMatchObject({ severity: "error", extensionId: "publisher.foo" });
    expect(diagnostic?.message).toContain("contributes.skills");
  });

  test("emits info diagnostic for unknown optional manifest fields including icon", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {},
          icon: "icon.png",
          futureField: { whatever: true },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const infoCodes = result.diagnostics.filter((d) => d.severity === "info").map((d) => d.code);
    expect(infoCodes).toContain("manifest.unknown_field");
    const fields = result.diagnostics
      .filter((d) => d.code === "manifest.unknown_field")
      .map((d) => d.message);
    expect(fields.some((m) => m.includes("icon"))).toBe(true);
    expect(fields.some((m) => m.includes("futureField"))).toBe(true);
  });

  test("accepts only http(s) homepage values", () => {
    const good = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          homepage: "https://example.com/docs",
          contributes: {},
        },
      })
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.manifest.homepage).toBe("https://example.com/docs");
    }

    const bad = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          homepage: "javascript:alert(1)",
          contributes: {},
        },
      })
    );
    expect(bad.ok).toBe(true);
    if (!bad.ok) return;
    expect(bad.manifest.homepage).toBeUndefined();
    expect(
      bad.diagnostics.some((d) => d.code === "manifest.homepage.invalid" && d.severity === "warn")
    ).toBe(true);
  });
});

describe("Reserved Extension Identity Prefix", () => {
  test("non-bundled root claiming `mux.evil` is rejected with extension.identity.reserved", () => {
    const result = validateManifest(
      input({
        rootKind: "user-global",
        rawMux: {
          manifestVersion: 1,
          id: "mux.evil",
          contributes: { skills: [{ id: "x", body: "x.md" }] },
        },
      })
    );
    expect(result.ok).toBe(false);
    const reserved = result.diagnostics.find((d) => d.code === "extension.identity.reserved");
    expect(reserved).toBeDefined();
    expect(reserved?.severity).toBe("error");
    expect(reserved?.extensionId).toBe("mux.evil");
  });

  test("non-bundled root claiming bare `mux` (no dot) is also reserved", () => {
    // The bare token "mux" fails the identity regex (needs a dotted segment)
    // but the validator must still treat any mux/mux.* claim from a non-bundled
    // root as reserved so a regex tweak doesn't open the boundary.
    const result = validateManifest(
      input({
        rootKind: "project-local",
        rawMux: { manifestVersion: 1, id: "mux", contributes: {} },
      })
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "extension.identity.reserved")).toBe(true);
  });

  test("bundled root may claim `mux.platformDemo`", () => {
    const result = validateManifest(
      input({
        rootKind: "bundled",
        rawMux: { manifestVersion: 1, id: "mux.platformdemo", contributes: {} },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.id).toBe("mux.platformdemo");
  });

  test("non-bundled identity that merely contains `mux` as a sub-segment is allowed", () => {
    const result = validateManifest(
      input({
        rootKind: "user-global",
        rawMux: { manifestVersion: 1, id: "publisher.muxfoo", contributes: {} },
      })
    );
    expect(result.ok).toBe(true);
  });
});

describe("Registration Capabilities", () => {
  test("declared skills materializes skill.register and merges with explicit effect capabilities", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            skills: [{ id: "my-skill", body: "skills/my-skill/SKILL.md" }],
          },
          requestedPermissions: ["network"],
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).toContain("network");
    expect(result.manifest.requestedPermissions).toContain("skill.register");
  });

  test("declared agents and themes each materialize their own registration capability", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            agents: [{ id: "my-agent", body: "agents/my-agent.md" }],
            themes: [{ id: "my-theme", tokens: { background: "#000" } }],
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).toContain("agent.register");
    expect(result.manifest.requestedPermissions).toContain("theme.register");
  });

  test("an empty contribution list does not infer a registration capability", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: { skills: [] },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).not.toContain("skill.register");
  });

  test("dedupes when an author redundantly lists the inferred permission explicitly", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            skills: [{ id: "my-skill", body: "skills/my-skill/SKILL.md" }],
          },
          requestedPermissions: ["skill.register", "network"],
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skillRegisters = result.manifest.requestedPermissions.filter(
      (p) => p === "skill.register"
    );
    expect(skillRegisters).toHaveLength(1);
  });

  test("provisional descriptor types also infer their register permissions", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            tools: [{ id: "my-tool" }],
            mcpServers: [{ id: "my-mcp" }],
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).toContain("tool.register");
    expect(result.manifest.requestedPermissions).toContain("mcpServer.register");
  });
});

describe("per-contribution descriptor handling", () => {
  test("a single bad contribution emits a contribution-level warn diagnostic without invalidating the manifest", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            skills: [
              { id: "good-skill", body: "skills/good/SKILL.md" },
              { id: "bad-skill", body: "../escape.md" },
            ],
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warn = result.diagnostics.find((d) => d.code === "contribution.invalid");
    expect(warn).toBeDefined();
    expect(warn?.severity).toBe("warn");
    expect(warn?.contributionRef).toMatchObject({ type: "skills", index: 1 });
    // skill.register is still inferred because at least one valid skill remains.
    expect(result.manifest.requestedPermissions).toContain("skill.register");
  });

  test("unknown descriptor version on a single contribution does not invalidate other contributions", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            skills: [
              { id: "ok", body: "skills/ok.md" },
              { id: "bad", body: "skills/bad.md", descriptorVersion: 99 },
            ],
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diag = result.diagnostics.find((d) => d.code === "contribution.invalid");
    expect(diag).toBeDefined();
    expect(diag?.contributionRef).toMatchObject({ type: "skills", index: 1, id: "bad" });
  });

  test("when ALL contributions of a type are invalid, the inferred register permission is not emitted", () => {
    const result = validateManifest(
      input({
        rawMux: {
          manifestVersion: 1,
          id: "publisher.foo",
          contributes: {
            skills: [{ id: "bad", body: "/etc/passwd" }],
          },
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.requestedPermissions).not.toContain("skill.register");
  });
});

describe("diagnostic record shape", () => {
  test("every diagnostic carries code, severity, message, and occurredAt", () => {
    const result = validateManifest(
      input({
        rawMux: { manifestVersion: 999, id: "publisher.foo", contributes: {} },
        now: 42,
      })
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
