import * as fs from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { DisposableTempDir } from "@/node/services/tempDir";
import { discoverAgentPlugins } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0 } from "./manifest";

async function writePlugin(
  containerPath: string,
  dirName: string,
  options?: {
    manifest?: unknown;
    rawManifest?: string;
    skills?: string[];
    mcpJson?: string;
  }
): Promise<string> {
  const pluginDir = path.join(containerPath, dirName);
  await fs.mkdir(pluginDir, { recursive: true });

  const manifest = options?.manifest ?? {
    $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
    name: dirName,
  };
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    options?.rawManifest ?? JSON.stringify(manifest),
    "utf8"
  );

  for (const skillName of options?.skills ?? []) {
    const skillDir = path.join(pluginDir, "skills", skillName);
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---\nname: ${skillName}\ndescription: Test skill\n---\nBody\n`,
      "utf8"
    );
  }

  if (options?.mcpJson !== undefined) {
    await fs.writeFile(path.join(pluginDir, "mcp.json"), options.mcpJson, "utf8");
  }

  return pluginDir;
}

describe("discoverAgentPlugins", () => {
  test("discovers a valid plugin with skills and mcp.json component paths", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "hello-plugin", { skills: ["greet"], mcpJson: "{}" });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    const plugin = result.plugins[0];
    expect(plugin.name).toBe("hello-plugin");
    expect(plugin.scope).toBe("global");
    expect(plugin.rootPath).toBe(await fs.realpath(path.join(container, "hello-plugin")));
    expect(plugin.skillsDir).toBe(path.join(plugin.rootPath, "skills"));
    expect(plugin.mcpConfigPath).toBe(path.join(plugin.rootPath, "mcp.json"));
    expect(result.diagnostics).toEqual([]);
  });

  test("discovers a manifest-only plugin without components", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "bare-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "project" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
  });

  test("silently skips entries without plugin.json (e.g. Codex marketplace dirs)", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(path.join(container, "not-a-plugin"), { recursive: true });
    await fs.writeFile(path.join(container, "not-a-plugin", "marketplace.json"), "{}", "utf8");
    // Loose file directly in the container is also skipped.
    await fs.writeFile(path.join(container, "marketplace.json"), "{}", "utf8");
    await writePlugin(container, "real-plugin");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["real-plugin"]);
    expect(result.diagnostics).toEqual([]);
  });

  test("a broken sibling plugin never affects a valid one", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "a-broken", { rawManifest: "{ not json" });
    await writePlugin(container, "b-invalid", {
      manifest: { $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "Bad--Name" },
    });
    await writePlugin(container, "c-valid");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["c-valid"]);
    expect(result.diagnostics).toHaveLength(2);
    expect(result.diagnostics.every((d) => d.severity === "error")).toBe(true);
  });

  test("reports unsupported $schema distinctly from invalid manifests", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "future-plugin", {
      manifest: {
        $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
        name: "future-plugin",
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("Unsupported Agent Plugins version");
  });

  test("loads plugins with unknown top-level manifest fields and reports a warning", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "extra-plugin", {
      manifest: {
        $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0,
        name: "extra-plugin",
        commands: ["x"],
      },
    });

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins.map((p) => p.name)).toEqual(["extra-plugin"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].severity).toBe("warning");
    expect(result.diagnostics[0].message).toContain("commands");
  });

  test("rejects a plugin whose plugin.json symlink escapes the plugin root", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outside = path.join(tmp.path, "outside.json");
    await fs.writeFile(
      outside,
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "escaper" }),
      "utf8"
    );
    const pluginDir = path.join(container, "escaper");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.symlink(outside, path.join(pluginDir, "plugin.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("outside the plugin root");
  });

  test("skills symlink escaping the root invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const outsideSkills = path.join(tmp.path, "outside-skills");
    await fs.mkdir(outsideSkills, { recursive: true });
    const pluginDir = await writePlugin(container, "escaping-skills", { mcpJson: "{}" });
    await fs.symlink(outsideSkills, path.join(pluginDir, "skills"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    // MCP component is unaffected (§6.2 narrowest-scope invalidation).
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("skills/");
  });

  test("mcp.json of the wrong filesystem kind invalidates only the MCP component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "dir-mcp", { skills: ["greet"] });
    await fs.mkdir(path.join(pluginDir, "mcp.json"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].mcpConfigPath).toBeUndefined();
    expect(result.plugins[0].skillsDir).toBeDefined();
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].message).toContain("mcp.json");
  });

  test("skills location that is a file invalidates only the skills component", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    const pluginDir = await writePlugin(container, "file-skills", { mcpJson: "{}" });
    await fs.writeFile(path.join(pluginDir, "skills"), "not a dir", "utf8");

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].skillsDir).toBeUndefined();
    expect(result.plugins[0].mcpConfigPath).toBeDefined();
  });

  test("a symlinked plugin directory anchors containment at its realpath", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await fs.mkdir(container, { recursive: true });
    const actual = path.join(tmp.path, "elsewhere", "linked-plugin");
    await fs.mkdir(actual, { recursive: true });
    await fs.writeFile(
      path.join(actual, "plugin.json"),
      JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name: "linked-plugin" }),
      "utf8"
    );
    await fs.symlink(actual, path.join(container, "linked-plugin"));

    const result = await discoverAgentPlugins([{ path: container, scope: "global" }]);

    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].rootPath).toBe(await fs.realpath(actual));
    expect(result.diagnostics).toEqual([]);
  });

  test("missing containers yield no plugins and no diagnostics", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const result = await discoverAgentPlugins([
      { path: path.join(tmp.path, "does-not-exist"), scope: "global" },
    ]);
    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("throws on relative container paths", async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun-types mistype .rejects.toThrow as void
    await expect(
      discoverAgentPlugins([{ path: "relative/plugins", scope: "global" }])
    ).rejects.toThrow("must be absolute");
  });

  test("dedupes repeated container paths and orders plugins alphabetically per container", async () => {
    using tmp = new DisposableTempDir("agent-plugins");
    const container = path.join(tmp.path, "plugins");
    await writePlugin(container, "zeta");
    await writePlugin(container, "alpha");

    const result = await discoverAgentPlugins([
      { path: container, scope: "global" },
      { path: container, scope: "global" },
    ]);

    expect(result.plugins.map((p) => p.name)).toEqual(["alpha", "zeta"]);
  });
});
