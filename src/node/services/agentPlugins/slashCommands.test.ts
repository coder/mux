import { describe, expect, test } from "bun:test";

import type { AgentPluginInfo } from "./discovery";
import { AGENT_PLUGIN_SCHEMA_ID_1_0_0, type AgentPluginContributes } from "./manifest";
import { collectPluginSlashCommands } from "./slashCommands";

function pluginWithCommands(
  name: string,
  scope: "project" | "global",
  contributes: AgentPluginContributes
): AgentPluginInfo {
  return {
    name,
    scope,
    rootPath: `/plugins/${name}`,
    containerPath: "/plugins",
    dirName: name,
    manifest: { schemaId: AGENT_PLUGIN_SCHEMA_ID_1_0_0, name, contributes },
  };
}

describe("collectPluginSlashCommands", () => {
  test("collects contributed commands with plugin attribution", () => {
    const commands = collectPluginSlashCommands([
      pluginWithCommands("my-plugin", "global", {
        slashCommands: [{ name: "greet", description: "Say hello", expansion: "Hello!" }],
      }),
    ]);

    expect(commands).toEqual([
      {
        name: "greet",
        description: "Say hello",
        expansion: "Hello!",
        pluginName: "my-plugin",
        scope: "global",
      },
    ]);
  });

  test("first plugin in precedence order wins on duplicate command names", () => {
    const commands = collectPluginSlashCommands([
      pluginWithCommands("project-plugin", "project", {
        slashCommands: [{ name: "greet", expansion: "project wins" }],
      }),
      pluginWithCommands("global-plugin", "global", {
        slashCommands: [{ name: "greet", expansion: "global loses" }],
      }),
    ]);

    expect(commands).toHaveLength(1);
    expect(commands[0]?.pluginName).toBe("project-plugin");
    expect(commands[0]?.expansion).toBe("project wins");
  });

  test("plugins without contributed commands yield nothing", () => {
    expect(collectPluginSlashCommands([pluginWithCommands("empty", "global", {})])).toEqual([]);
  });
});
