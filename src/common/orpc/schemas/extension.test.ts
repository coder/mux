import { describe, expect, test } from "bun:test";
import {
  AgentDescriptorSchema,
  AgentLifecycleHookDescriptorSchema,
  CommandDescriptorSchema,
  CommandTargetIdSchema,
  ContributionIdSchema,
  ExtensionContributesV1Schema,
  ExtensionIdentitySchema,
  ExtensionManifestSchema,
  ExtensionManifestV1Schema,
  LayoutDescriptorSchema,
  McpServerDescriptorSchema,
  PanelDescriptorSchema,
  RelativeBodyPathSchema,
  RuntimeDriverDescriptorSchema,
  RuntimePresetDescriptorSchema,
  SecretProviderDescriptorSchema,
  SkillDescriptorSchema,
  ThemeDescriptorSchema,
  ToolDescriptorSchema,
} from "./extension";

function manifest(overrides: Record<string, unknown> = {}): unknown {
  return {
    manifestVersion: 1,
    id: "publisher.foo",
    contributes: {},
    ...overrides,
  };
}

describe("ExtensionIdentitySchema", () => {
  test("accepts dotted reverse-domain ids", () => {
    for (const id of ["publisher.foo", "mux.platformdemo", "a.b.c", "foo.bar-baz"]) {
      expect(ExtensionIdentitySchema.safeParse(id).success).toBe(true);
    }
  });

  test("rejects ids without a dotted segment", () => {
    for (const id of ["foo", "FOO.bar", "foo.", ".foo", "foo..bar", "foo.-bar", "foo.bar_baz"]) {
      expect(ExtensionIdentitySchema.safeParse(id).success).toBe(false);
    }
  });
});

describe("ExtensionManifestSchema (v1 envelope)", () => {
  test("parses a minimal valid v1 manifest", () => {
    expect(ExtensionManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  test("requires manifestVersion, id, and contributes", () => {
    expect(
      ExtensionManifestSchema.safeParse({ id: "publisher.foo", contributes: {} }).success
    ).toBe(false);
    expect(ExtensionManifestSchema.safeParse({ manifestVersion: 1, contributes: {} }).success).toBe(
      false
    );
    expect(
      ExtensionManifestSchema.safeParse({ manifestVersion: 1, id: "publisher.foo" }).success
    ).toBe(false);
  });

  test("rejects unknown manifestVersion values via discriminated schema", () => {
    for (const version of [0, 2, "1", null]) {
      const result = ExtensionManifestSchema.safeParse(
        manifest({ manifestVersion: version as unknown })
      );
      expect(result.success).toBe(false);
    }
  });

  test("accepts optional envelope fields when present", () => {
    const parsed = ExtensionManifestV1Schema.parse(
      manifest({
        displayName: "Foo",
        description: "Demo extension",
        publisher: "publisher",
        homepage: "https://example.com",
        requestedPermissions: ["network", "shell.execute"],
      })
    );
    expect(parsed.displayName).toBe("Foo");
    expect(parsed.requestedPermissions).toEqual(["network", "shell.execute"]);
  });

  test("accepts unknown optional manifest fields without rejection (icon tolerated)", () => {
    const result = ExtensionManifestV1Schema.safeParse(
      manifest({
        icon: "icon.png",
        futureField: { whatever: true },
      })
    );
    expect(result.success).toBe(true);
  });
});

describe("ExtensionContributesV1Schema (closed shape)", () => {
  test("accepts an empty contributes block", () => {
    expect(ExtensionContributesV1Schema.safeParse({}).success).toBe(true);
  });

  test("accepts known contribution-type keys", () => {
    const result = ExtensionContributesV1Schema.safeParse({
      skills: [],
      agents: [],
      themes: [],
      layouts: [],
      runtimePresets: [],
      commands: [],
      runtimeDrivers: [],
      tools: [],
      mcpServers: [],
      panels: [],
      agentLifecycleHooks: [],
      secretProviders: [],
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown top-level keys inside contributes", () => {
    const result = ExtensionContributesV1Schema.safeParse({ widgets: [] });
    expect(result.success).toBe(false);
  });
});

describe("ContributionIdSchema (kebab-case)", () => {
  test("accepts kebab-case ids", () => {
    for (const id of ["foo", "foo-bar", "a1", "a-b-c-d"]) {
      expect(ContributionIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test("rejects invalid ids", () => {
    for (const id of ["", "Foo", "foo_bar", "-foo", "foo-", "foo--bar", "foo bar"]) {
      expect(ContributionIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe("RelativeBodyPathSchema", () => {
  test("accepts relative paths", () => {
    for (const p of ["SKILL.md", "skills/foo/SKILL.md", "agents/my-agent.md", "a/b/c.md"]) {
      expect(RelativeBodyPathSchema.safeParse(p).success).toBe(true);
    }
  });

  test("rejects absolute paths", () => {
    for (const p of ["/etc/passwd", "/skills/foo.md", "C:/Users/foo.md", "C:\\Users\\foo.md"]) {
      expect(RelativeBodyPathSchema.safeParse(p).success).toBe(false);
    }
  });

  test("rejects parent-traversal segments", () => {
    for (const p of ["../foo.md", "skills/../escape.md", "skills\\..\\escape.md", ".."]) {
      expect(RelativeBodyPathSchema.safeParse(p).success).toBe(false);
    }
  });

  test("rejects null bytes", () => {
    expect(RelativeBodyPathSchema.safeParse("foo\0bar.md").success).toBe(false);
  });
});

describe("CommandTargetIdSchema", () => {
  test("accepts mux-namespaced target ids", () => {
    for (const id of ["mux.workspace", "mux.workspace.create", "mux.chat.send"]) {
      expect(CommandTargetIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test("rejects non-mux ids and malformed segments", () => {
    for (const id of [
      "workspace.create",
      "MUX.workspace",
      "mux",
      "mux.",
      "mux.Workspace",
      "mux.foo-bar",
      "mux.foo..bar",
    ]) {
      expect(CommandTargetIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe("SkillDescriptorSchema", () => {
  const minimal = { id: "my-skill", body: "skills/my-skill/SKILL.md" } as const;

  test("defaults missing descriptorVersion to 1", () => {
    const result = SkillDescriptorSchema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.descriptorVersion).toBe(1);
    }
  });

  test("accepts explicit descriptorVersion 1 with optional fields", () => {
    const result = SkillDescriptorSchema.safeParse({
      ...minimal,
      descriptorVersion: 1,
      displayName: "My Skill",
      description: "Demo",
      advertise: false,
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    for (const v of [0, 2, "1", null]) {
      const result = SkillDescriptorSchema.safeParse({ ...minimal, descriptorVersion: v });
      expect(result.success).toBe(false);
    }
  });

  test("tolerates additive optional fields at v1 (passthrough)", () => {
    const result = SkillDescriptorSchema.safeParse({
      ...minimal,
      futureField: { whatever: true },
    });
    expect(result.success).toBe(true);
  });

  test("rejects ids longer than agent skill names", () => {
    const overlongSkillId = "a".repeat(65);
    expect(SkillDescriptorSchema.safeParse({ id: overlongSkillId, body: "SKILL.md" }).success).toBe(
      false
    );
  });

  test("rejects body paths with traversal or absolute prefix", () => {
    expect(SkillDescriptorSchema.safeParse({ id: "my-skill", body: "../escape.md" }).success).toBe(
      false
    );
    expect(SkillDescriptorSchema.safeParse({ id: "my-skill", body: "/etc/passwd" }).success).toBe(
      false
    );
  });

  test("requires id and body", () => {
    expect(SkillDescriptorSchema.safeParse({ id: "my-skill" }).success).toBe(false);
    expect(SkillDescriptorSchema.safeParse({ body: "skills/x/SKILL.md" }).success).toBe(false);
  });
});

describe("AgentDescriptorSchema", () => {
  const minimal = { id: "my-agent", body: "agents/my-agent.md" } as const;

  test("defaults missing descriptorVersion to 1", () => {
    const result = AgentDescriptorSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    expect(AgentDescriptorSchema.safeParse({ ...minimal, descriptorVersion: 2 }).success).toBe(
      false
    );
  });

  test("rejects body paths with traversal", () => {
    expect(
      AgentDescriptorSchema.safeParse({ id: "my-agent", body: "agents/../escape.md" }).success
    ).toBe(false);
  });

  test("tolerates additive optional fields", () => {
    expect(AgentDescriptorSchema.safeParse({ ...minimal, badge: "beta" }).success).toBe(true);
  });
});

describe("ThemeDescriptorSchema", () => {
  const minimal = {
    id: "my-theme",
    tokens: { background: "#000000", foreground: "#ffffff" },
  } as const;

  test("defaults missing descriptorVersion to 1", () => {
    expect(ThemeDescriptorSchema.safeParse(minimal).success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    expect(ThemeDescriptorSchema.safeParse({ ...minimal, descriptorVersion: 2 }).success).toBe(
      false
    );
  });

  test("rejects unknown token keys (curated whitelist)", () => {
    const result = ThemeDescriptorSchema.safeParse({
      id: "my-theme",
      tokens: { notARealToken: "#000000" },
    });
    expect(result.success).toBe(false);
  });

  test("accepts subset of curated tokens", () => {
    expect(
      ThemeDescriptorSchema.safeParse({
        id: "my-theme",
        tokens: { accent: "hsl(210 70% 40%)" },
      }).success
    ).toBe(true);
  });

  test("rejects empty token values", () => {
    expect(
      ThemeDescriptorSchema.safeParse({
        id: "my-theme",
        tokens: { background: "" },
      }).success
    ).toBe(false);
  });
});

describe("LayoutDescriptorSchema", () => {
  test("rejects unknown descriptorVersion", () => {
    const result = LayoutDescriptorSchema.safeParse({
      id: "my-layout",
      descriptorVersion: 2,
      preset: {},
    });
    expect(result.success).toBe(false);
  });

  test("requires a valid id", () => {
    const result = LayoutDescriptorSchema.safeParse({
      id: "Bad ID",
      preset: {
        id: "p1",
        name: "P1",
        leftSidebarCollapsed: false,
        rightSidebar: {
          collapsed: false,
          width: { mode: "px", value: 360 },
          layout: {
            version: 1,
            nextId: 1,
            focusedTabsetId: "ts1",
            root: { type: "tabset", id: "ts1", tabs: ["costs"], activeTab: "costs" },
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("RuntimePresetDescriptorSchema", () => {
  test("accepts a minimal local runtime preset and defaults version", () => {
    const result = RuntimePresetDescriptorSchema.safeParse({
      id: "my-runtime",
      runtime: { type: "local" },
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    expect(
      RuntimePresetDescriptorSchema.safeParse({
        id: "my-runtime",
        descriptorVersion: 2,
        runtime: { type: "local" },
      }).success
    ).toBe(false);
  });
});

describe("CommandDescriptorSchema", () => {
  const minimal = {
    id: "my-command",
    target: "mux.workspace.create",
    title: "Create Workspace",
  } as const;

  test("defaults missing descriptorVersion to 1", () => {
    expect(CommandDescriptorSchema.safeParse(minimal).success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    expect(CommandDescriptorSchema.safeParse({ ...minimal, descriptorVersion: 2 }).success).toBe(
      false
    );
  });

  test("rejects target ids outside the mux.* namespace", () => {
    expect(
      CommandDescriptorSchema.safeParse({ ...minimal, target: "evil.workspace.create" }).success
    ).toBe(false);
  });

  test("requires a non-empty title", () => {
    expect(CommandDescriptorSchema.safeParse({ ...minimal, title: "" }).success).toBe(false);
  });

  test("tolerates additive optional fields", () => {
    expect(CommandDescriptorSchema.safeParse({ ...minimal, keybind: "cmd+k" }).success).toBe(true);
  });
});

// Provisional Descriptors (US-003) — inspection-only contribution types.
// Same descriptor-version envelope as available types: default-1, reject
// unknown versions, passthrough for additive fields, descriptor-only
// (no executable handler/view/runtime fields).
const provisionalCases = [
  ["RuntimeDriverDescriptorSchema", RuntimeDriverDescriptorSchema],
  ["ToolDescriptorSchema", ToolDescriptorSchema],
  ["McpServerDescriptorSchema", McpServerDescriptorSchema],
  ["PanelDescriptorSchema", PanelDescriptorSchema],
  ["AgentLifecycleHookDescriptorSchema", AgentLifecycleHookDescriptorSchema],
  ["SecretProviderDescriptorSchema", SecretProviderDescriptorSchema],
] as const;

describe.each(provisionalCases)("%s (provisional descriptor)", (_name, schema) => {
  const minimal = { id: "my-thing" } as const;

  test("defaults missing descriptorVersion to 1", () => {
    const result = schema.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as { descriptorVersion: number }).descriptorVersion).toBe(1);
    }
  });

  test("accepts explicit descriptorVersion 1 with optional inspection metadata", () => {
    const result = schema.safeParse({
      ...minimal,
      descriptorVersion: 1,
      displayName: "My Thing",
      description: "Demo provisional descriptor",
    });
    expect(result.success).toBe(true);
  });

  test("rejects unknown descriptorVersion", () => {
    for (const v of [0, 2, "1", null]) {
      const result = schema.safeParse({ ...minimal, descriptorVersion: v });
      expect(result.success).toBe(false);
    }
  });

  test("rejects invalid id", () => {
    expect(schema.safeParse({ id: "Bad ID" }).success).toBe(false);
  });

  test("requires id", () => {
    expect(schema.safeParse({}).success).toBe(false);
  });

  test("tolerates additive optional fields at v1 (passthrough)", () => {
    const result = schema.safeParse({
      ...minimal,
      futureField: { whatever: true },
    });
    expect(result.success).toBe(true);
  });
});
