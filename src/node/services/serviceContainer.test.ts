import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  MUX_HELP_CHAT_AGENT_ID,
  MUX_HELP_CHAT_WORKSPACE_ID,
  MUX_HELP_CHAT_WORKSPACE_NAME,
  MUX_HELP_CHAT_WORKSPACE_TITLE,
} from "@/common/constants/muxChat";
import { getMuxHelpChatProjectPath } from "@/node/constants/muxChat";
import { Config } from "@/node/config";
import { ServiceContainer } from "./serviceContainer";

describe("ServiceContainer", () => {
  let tempDir: string;
  let config: Config;
  let services: ServiceContainer | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-service-container-test-"));
    config = new Config(tempDir);
  });

  afterEach(async () => {
    if (services) {
      await services.dispose();
      await services.shutdown();
      services = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes stale mux-chat entries from other roots and keeps exactly one active system workspace", async () => {
    const activeProjectPath = getMuxHelpChatProjectPath(config.rootDir);
    const staleProjectPath = path.join(`${config.rootDir}-legacy`, "system", "Mux");

    await config.editConfig((cfg) => {
      cfg.projects.set(activeProjectPath, {
        workspaces: [
          {
            path: activeProjectPath,
            id: MUX_HELP_CHAT_WORKSPACE_ID,
            name: "wrong-name",
            title: "Wrong Title",
            agentId: "not-mux",
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeConfig: { type: "local" },
            archivedAt: "2026-01-02T00:00:00.000Z",
          },
          {
            path: activeProjectPath,
            id: MUX_HELP_CHAT_WORKSPACE_ID,
            name: "duplicate",
            title: "Duplicate",
            agentId: MUX_HELP_CHAT_AGENT_ID,
            createdAt: "2026-01-03T00:00:00.000Z",
            runtimeConfig: { type: "local" },
          },
        ],
      });
      cfg.projects.set(staleProjectPath, {
        workspaces: [
          {
            path: staleProjectPath,
            id: MUX_HELP_CHAT_WORKSPACE_ID,
            name: MUX_HELP_CHAT_WORKSPACE_NAME,
            title: MUX_HELP_CHAT_WORKSPACE_TITLE,
            agentId: MUX_HELP_CHAT_AGENT_ID,
            createdAt: "2026-01-04T00:00:00.000Z",
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return cfg;
    });

    services = new ServiceContainer(config);
    await services.initialize();

    const loaded = config.loadConfigOrDefault();
    expect(loaded.projects.has(staleProjectPath)).toBe(false);

    const muxChatEntries = Array.from(loaded.projects.values())
      .flatMap((project) => project.workspaces)
      .filter((workspace) => workspace.id === MUX_HELP_CHAT_WORKSPACE_ID);

    expect(muxChatEntries).toHaveLength(1);

    const activeProject = loaded.projects.get(activeProjectPath);
    expect(activeProject).toBeDefined();
    expect(activeProject?.workspaces).toHaveLength(1);

    const muxChatWorkspace = activeProject?.workspaces[0];
    expect(muxChatWorkspace?.path).toBe(activeProjectPath);
    expect(muxChatWorkspace?.id).toBe(MUX_HELP_CHAT_WORKSPACE_ID);
    expect(muxChatWorkspace?.name).toBe(MUX_HELP_CHAT_WORKSPACE_NAME);
    expect(muxChatWorkspace?.title).toBe(MUX_HELP_CHAT_WORKSPACE_TITLE);
    expect(muxChatWorkspace?.agentId).toBe(MUX_HELP_CHAT_AGENT_ID);
    expect(muxChatWorkspace?.runtimeConfig).toEqual({ type: "local" });
    expect(muxChatWorkspace?.archivedAt).toBeUndefined();
    expect(muxChatWorkspace?.unarchivedAt).toBeUndefined();
  });

  it("keeps non-system legacy workspaces whose IDs also equal mux-chat", async () => {
    const legacyProjectPath = path.join(tempDir, "repos", "mux");
    const legacyWorkspacePath = path.join(config.srcDir, "mux", "chat");

    await config.editConfig((cfg) => {
      cfg.projects.set(legacyProjectPath, {
        workspaces: [
          {
            path: legacyWorkspacePath,
            id: MUX_HELP_CHAT_WORKSPACE_ID,
            name: "chat",
            title: "Legacy Chat Branch",
            runtimeConfig: { type: "local" },
          },
        ],
      });
      return cfg;
    });

    services = new ServiceContainer(config);
    await services.initialize();

    const loaded = config.loadConfigOrDefault();
    const legacyProject = loaded.projects.get(legacyProjectPath);

    expect(legacyProject).toBeDefined();
    expect(legacyProject?.workspaces).toHaveLength(1);
    expect(legacyProject?.workspaces[0].id).toBe(MUX_HELP_CHAT_WORKSPACE_ID);
    expect(legacyProject?.workspaces[0].path).toBe(legacyWorkspacePath);

    const activeSystemProject = loaded.projects.get(getMuxHelpChatProjectPath(config.rootDir));
    expect(activeSystemProject).toBeDefined();
    expect(
      activeSystemProject?.workspaces.some(
        (workspace) => workspace.id === MUX_HELP_CHAT_WORKSPACE_ID
      )
    ).toBe(true);
  });
});
