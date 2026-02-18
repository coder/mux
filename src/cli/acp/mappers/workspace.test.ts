import { beforeEach, describe, expect, it, vi } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";
import type { RouterClient } from "@orpc/server";
import type { FrontendWorkspaceMetadataSchemaType } from "@/common/orpc/types";
import { resolveModelAlias } from "@/common/utils/ai/models";
import * as gitModule from "@/node/git";
import type { AppRouter } from "@/node/orpc/router";

import {
  createWorkspaceBackedSession,
  forkWorkspaceBackedSession,
  listWorkspaceBackedSessions,
  loadWorkspaceBackedSession,
  parseMuxMeta,
  resumeWorkspaceBackedSession,
} from "./workspace";

function makeWorkspaceMetadata(
  overrides: Partial<FrontendWorkspaceMetadataSchemaType> = {}
): FrontendWorkspaceMetadataSchemaType {
  return {
    id: overrides.id ?? "workspace-1",
    name: overrides.name ?? "feature/acp",
    title: overrides.title,
    projectName: overrides.projectName ?? "project",
    projectPath: overrides.projectPath ?? "/tmp/project",
    createdAt: overrides.createdAt ?? "2026-02-01T00:00:00.000Z",
    aiSettingsByAgent: overrides.aiSettingsByAgent,
    runtimeConfig: overrides.runtimeConfig ?? { type: "local" },
    aiSettings: overrides.aiSettings,
    parentWorkspaceId: overrides.parentWorkspaceId,
    agentType: overrides.agentType,
    agentId: overrides.agentId,
    taskStatus: overrides.taskStatus,
    reportedAt: overrides.reportedAt,
    taskModelString: overrides.taskModelString,
    taskThinkingLevel: overrides.taskThinkingLevel,
    taskPrompt: overrides.taskPrompt,
    taskTrunkBranch: overrides.taskTrunkBranch,
    archivedAt: overrides.archivedAt,
    unarchivedAt: overrides.unarchivedAt,
    sectionId: overrides.sectionId,
    namedWorkspacePath: overrides.namedWorkspacePath ?? "/tmp/project/.mux/workspace-1",
    incompatibleRuntime: overrides.incompatibleRuntime,
    isRemoving: overrides.isRemoving,
    isInitializing: overrides.isInitializing,
  };
}

function makeClient(overrides: {
  create?: ReturnType<typeof vi.fn>;
  list?: ReturnType<typeof vi.fn>;
  getInfo?: ReturnType<typeof vi.fn>;
  fork?: ReturnType<typeof vi.fn>;
  remove?: ReturnType<typeof vi.fn>;
  mcpList?: ReturnType<typeof vi.fn>;
  mcpAdd?: ReturnType<typeof vi.fn>;
  mcpSetEnabled?: ReturnType<typeof vi.fn>;
  workspaceMcpGet?: ReturnType<typeof vi.fn>;
  workspaceMcpSet?: ReturnType<typeof vi.fn>;
}): RouterClient<AppRouter> {
  return {
    mcp: {
      list: overrides.mcpList ?? vi.fn().mockResolvedValue({}),
      add: overrides.mcpAdd ?? vi.fn().mockResolvedValue({ success: true, data: undefined }),
      setEnabled:
        overrides.mcpSetEnabled ?? vi.fn().mockResolvedValue({ success: true, data: undefined }),
    },
    workspace: {
      create: overrides.create ?? vi.fn(),
      list: overrides.list ?? vi.fn(),
      getInfo: overrides.getInfo ?? vi.fn(),
      fork: overrides.fork ?? vi.fn(),
      remove: overrides.remove ?? vi.fn().mockResolvedValue({ success: true }),
      mcp: {
        get: overrides.workspaceMcpGet ?? vi.fn().mockResolvedValue({}),
        set:
          overrides.workspaceMcpSet ??
          vi.fn().mockResolvedValue({ success: true, data: undefined }),
      },
    },
  } as unknown as RouterClient<AppRouter>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("parseMuxMeta", () => {
  it("returns empty metadata for null/undefined/empty inputs", () => {
    expect(parseMuxMeta(undefined)).toEqual({});
    expect(parseMuxMeta(null)).toEqual({});
    expect(parseMuxMeta({})).toEqual({});
  });

  it("parses nested _meta.mux config fields", () => {
    const parsed = parseMuxMeta({
      mux: {
        trunkBranch: "main",
        branchName: "feature/acp",
        title: "ACP Session",
        sectionId: "section-1",
        modeId: "plan",
        modelId: "opus",
        thinkingLevel: "MED",
        runtimeConfig: {
          type: "ssh",
          host: "ssh.example.com",
          srcBaseDir: "/srv/src",
        },
      },
    });

    expect(parsed).toEqual({
      trunkBranch: "main",
      branchName: "feature/acp",
      title: "ACP Session",
      sectionId: "section-1",
      modeId: "plan",
      modelId: resolveModelAlias("opus"),
      thinkingLevel: "medium",
      runtimeConfig: {
        type: "ssh",
        host: "ssh.example.com",
        srcBaseDir: "/srv/src",
      },
    });
  });

  it("parses flattened mux.* metadata keys", () => {
    const parsed = parseMuxMeta({
      "mux.modeId": "plan",
      "mux.modelId": "gpt",
      "mux.thinkingLevel": "high",
      "mux.unknown": "ignored",
    });

    expect(parsed).toEqual({
      modeId: "plan",
      modelId: resolveModelAlias("gpt"),
      thinkingLevel: "high",
      trunkBranch: undefined,
      branchName: undefined,
      title: undefined,
      sectionId: undefined,
    });
  });

  it("throws on invalid known field types", () => {
    expect(() =>
      parseMuxMeta({
        mux: {
          modeId: 123,
        },
      })
    ).toThrow("Invalid _meta.mux.modeId: expected string");
  });

  it("throws on invalid runtimeConfig payloads", () => {
    expect(() =>
      parseMuxMeta({
        mux: {
          runtimeConfig: {
            type: "ssh",
          },
        },
      })
    ).toThrow("Invalid _meta.mux.runtimeConfig payload");
  });

  it("ignores unknown mux keys", () => {
    const parsed = parseMuxMeta({
      mux: {
        branchName: "feature/acp",
        unknown: "value",
      },
    });

    expect(parsed.branchName).toBe("feature/acp");
    expect(parsed).not.toHaveProperty("unknown");
  });
});

describe("createWorkspaceBackedSession", () => {
  it("creates a session state using _meta overrides", async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-created",
        projectPath: "/repo",
        agentId: "exec",
        aiSettings: {
          model: "openai:gpt-5.2",
          thinkingLevel: "low",
        },
      }),
    });

    const client = makeClient({ create: createMock });

    const request: schema.NewSessionRequest = {
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        mux: {
          branchName: "feature/acp",
          trunkBranch: "develop",
          title: "ACP Workspace",
          sectionId: "section-2",
          modeId: "plan",
          modelId: "sonnet",
          thinkingLevel: "HIGH",
          runtimeConfig: {
            type: "ssh",
            host: "ssh.example.com",
            srcBaseDir: "/srv/src",
          },
        },
      },
    };

    const session = await createWorkspaceBackedSession(client, request);

    expect(createMock).toHaveBeenCalledWith({
      projectPath: "/repo",
      branchName: "feature-acp",
      trunkBranch: "develop",
      title: "ACP Workspace",
      runtimeConfig: {
        type: "ssh",
        host: "ssh.example.com",
        srcBaseDir: "/srv/src",
      },
      sectionId: "section-2",
    });

    expect(session).toEqual({
      sessionId: "workspace-created",
      workspaceId: "workspace-created",
      projectPath: "/repo",
      namedWorkspacePath: "/tmp/project/.mux/workspace-1",
      modeId: "plan",
      modelId: resolveModelAlias("sonnet"),
      thinkingLevel: "high",
      defaultModelId: "openai:gpt-5.2",
      defaultThinkingLevel: "low",
    });
  });

  it("auto-detects trunk for explicit worktree runtime when trunkBranch is omitted", async () => {
    const detectDefaultTrunkBranchMock = vi
      .spyOn(gitModule, "detectDefaultTrunkBranch")
      .mockResolvedValue("main");

    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-worktree",
        projectPath: "/repo",
      }),
    });

    const client = makeClient({ create: createMock });

    await createWorkspaceBackedSession(client, {
      cwd: "/repo",
      mcpServers: [],
      _meta: {
        mux: {
          runtimeConfig: {
            type: "worktree",
            srcBaseDir: "/tmp/mux/src",
          },
        },
      },
    });

    expect(detectDefaultTrunkBranchMock).toHaveBeenCalledWith("/repo");

    const createArg = createMock.mock.calls.at(0)?.[0] as
      | {
          projectPath: string;
          branchName: string;
          trunkBranch?: string;
          title?: string;
          runtimeConfig?: unknown;
          sectionId?: string;
        }
      | undefined;

    expect(createArg).toMatchObject({
      projectPath: "/repo",
      trunkBranch: "main",
      title: undefined,
      runtimeConfig: {
        type: "worktree",
        srcBaseDir: "/tmp/mux/src",
      },
      sectionId: undefined,
    });
    expect(createArg?.branchName).toMatch(/^acp-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("applies ACP mcpServers to new workspaces via MCP config and workspace overrides", async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-mcp",
        projectPath: "/repo",
      }),
    });
    const mcpListMock = vi.fn().mockResolvedValue({});
    const mcpAddMock = vi.fn().mockResolvedValue({ success: true, data: undefined });
    const mcpSetEnabledMock = vi.fn().mockResolvedValue({ success: true, data: undefined });
    const workspaceMcpGetMock = vi.fn().mockResolvedValue({
      enabledServers: ["existing-enabled"],
      disabledServers: ["existing-disabled", "stdio-server"],
      toolAllowlist: {
        "existing-enabled": ["tool-a"],
      },
    });
    const workspaceMcpSetMock = vi.fn().mockResolvedValue({ success: true, data: undefined });

    const client = makeClient({
      create: createMock,
      mcpList: mcpListMock,
      mcpAdd: mcpAddMock,
      mcpSetEnabled: mcpSetEnabledMock,
      workspaceMcpGet: workspaceMcpGetMock,
      workspaceMcpSet: workspaceMcpSetMock,
    });

    await createWorkspaceBackedSession(client, {
      cwd: "/repo",
      mcpServers: [
        {
          name: "stdio-server",
          command: "node",
          args: ["server.js", "--flag"],
          env: [
            {
              name: "MCP_TOKEN",
              value: "abc",
            },
          ],
        },
        {
          type: "http",
          name: "http-server",
          url: "https://mcp.example.com",
          headers: [
            {
              name: "Authorization",
              value: "Bearer abc",
            },
          ],
        },
      ],
      _meta: {
        mux: {
          trunkBranch: "main",
        },
      },
    });

    expect(mcpListMock).toHaveBeenCalledWith({ projectPath: "/repo" });
    expect(mcpAddMock).toHaveBeenCalledTimes(2);
    expect(mcpAddMock).toHaveBeenNthCalledWith(1, {
      name: "stdio-server",
      transport: "stdio",
      command: "MCP_TOKEN='abc' 'node' 'server.js' '--flag'",
    });
    expect(mcpAddMock).toHaveBeenNthCalledWith(2, {
      name: "http-server",
      transport: "http",
      url: "https://mcp.example.com",
      headers: {
        Authorization: "Bearer abc",
      },
    });

    expect(mcpSetEnabledMock).toHaveBeenCalledTimes(2);
    expect(mcpSetEnabledMock).toHaveBeenNthCalledWith(1, {
      name: "stdio-server",
      enabled: false,
    });
    expect(mcpSetEnabledMock).toHaveBeenNthCalledWith(2, {
      name: "http-server",
      enabled: false,
    });

    expect(workspaceMcpSetMock).toHaveBeenCalledWith({
      workspaceId: "workspace-mcp",
      overrides: {
        enabledServers: ["existing-enabled", "http-server", "stdio-server"],
        disabledServers: ["existing-disabled"],
        toolAllowlist: {
          "existing-enabled": ["tool-a"],
        },
      },
    });
  });

  it("removes newly created workspaces when ACP MCP setup fails", async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-rollback",
        projectPath: "/repo",
      }),
    });
    const removeMock = vi.fn().mockResolvedValue({ success: true });

    const client = makeClient({
      create: createMock,
      remove: removeMock,
    });

    let thrownError: unknown;
    try {
      await createWorkspaceBackedSession(client, {
        cwd: "/repo",
        mcpServers: [
          {
            name: "duplicate",
            command: "node",
            args: [],
            env: [],
          },
          {
            name: "duplicate",
            command: "bun",
            args: [],
            env: [],
          },
        ],
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain("was removed to avoid orphaned state");

    expect(removeMock).toHaveBeenCalledWith({
      workspaceId: "workspace-rollback",
      options: {
        force: true,
      },
    });
  });

  it("includes rollback errors when workspace cleanup fails", async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-rollback-fail",
        projectPath: "/repo",
      }),
    });
    const removeMock = vi.fn().mockResolvedValue({
      success: false,
      error: "remove failed",
    });

    const client = makeClient({
      create: createMock,
      remove: removeMock,
    });

    let thrownError: unknown;
    try {
      await createWorkspaceBackedSession(client, {
        cwd: "/repo",
        mcpServers: [
          {
            name: "duplicate",
            command: "node",
            args: [],
            env: [],
          },
          {
            name: "duplicate",
            command: "bun",
            args: [],
            env: [],
          },
        ],
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    expect((thrownError as Error).message).toContain(
      "Rollback failed for workspace workspace-rollback-fail: remove failed"
    );
  });

  it("falls back to persisted workspace AI settings when _meta is absent", async () => {
    const createMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-persisted",
        projectPath: "/repo",
        agentId: "plan",
        aiSettingsByAgent: {
          plan: {
            model: "openai:gpt-5.2",
            thinkingLevel: "medium",
          },
          exec: {
            model: "anthropic:claude-opus-4-6",
            thinkingLevel: "off",
          },
        },
      }),
    });

    const client = makeClient({ create: createMock });

    const request: schema.NewSessionRequest = {
      cwd: "/repo",
      mcpServers: [],
    };

    const session = await createWorkspaceBackedSession(client, request);

    const createArg = createMock.mock.calls.at(0)?.[0] as
      | {
          runtimeConfig?: unknown;
          trunkBranch?: string;
          branchName: string;
        }
      | undefined;
    expect(createArg?.runtimeConfig).toBeUndefined();
    expect(createArg?.branchName).toMatch(/^acp-[a-z0-9]+-[a-z0-9]+$/);

    expect(session.modeId).toBe("plan");
    expect(session.modelId).toBe("openai:gpt-5.2");
    expect(session.thinkingLevel).toBe("medium");
  });
});

describe("workspace ownership checks", () => {
  it("load/resume tolerate malformed namedWorkspacePath when projectPath matches cwd", async () => {
    const getInfoMock = vi.fn().mockResolvedValue(
      makeWorkspaceMetadata({
        id: "workspace-source",
        projectPath: "/repo",
        namedWorkspacePath: "relative/corrupted-path",
        agentId: "exec",
      })
    );

    const client = makeClient({
      getInfo: getInfoMock,
    });

    const loaded = await loadWorkspaceBackedSession(client, {
      sessionId: "workspace-source",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(loaded.workspaceId).toBe("workspace-source");

    const resumed = await resumeWorkspaceBackedSession(client, {
      sessionId: "workspace-source",
      cwd: "/repo",
      mcpServers: [],
    });
    expect(resumed.workspaceId).toBe("workspace-source");
  });
});

describe("forkWorkspaceBackedSession", () => {
  it("canonicalizes cwd matching and normalizes fork branch names", async () => {
    const getInfoMock = vi.fn().mockResolvedValue(
      makeWorkspaceMetadata({
        id: "workspace-source",
        projectPath: "/repo",
        namedWorkspacePath: "/repo/.mux/workspace-source",
        agentId: "exec",
      })
    );

    const forkMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-forked",
        projectPath: "/repo",
        namedWorkspacePath: "/repo/.mux/workspace-forked",
        agentId: "exec",
      }),
      projectPath: "/repo",
    });

    const client = makeClient({
      getInfo: getInfoMock,
      fork: forkMock,
    });

    const session = await forkWorkspaceBackedSession(
      client,
      {
        sessionId: "workspace-source",
        cwd: "/repo/",
        mcpServers: [],
        _meta: {
          mux: {
            branchName: "feature/acp",
          },
        },
      },
      undefined
    );

    expect(forkMock).toHaveBeenCalledWith({
      sourceWorkspaceId: "workspace-source",
      newName: "feature-acp",
    });
    expect(session.workspaceId).toBe("workspace-forked");
  });
  it("fork tolerates malformed namedWorkspacePath when projectPath matches cwd", async () => {
    const getInfoMock = vi.fn().mockResolvedValue(
      makeWorkspaceMetadata({
        id: "workspace-source",
        projectPath: "/repo",
        namedWorkspacePath: "broken/relative/path",
        agentId: "exec",
      })
    );

    const forkMock = vi.fn().mockResolvedValue({
      success: true,
      metadata: makeWorkspaceMetadata({
        id: "workspace-forked",
        projectPath: "/repo",
      }),
      projectPath: "/repo",
    });

    const client = makeClient({
      getInfo: getInfoMock,
      fork: forkMock,
    });

    const session = await forkWorkspaceBackedSession(
      client,
      {
        sessionId: "workspace-source",
        cwd: "/repo",
        mcpServers: [],
      },
      undefined
    );

    expect(forkMock).toHaveBeenCalledWith({
      sourceWorkspaceId: "workspace-source",
      newName: undefined,
    });
    expect(session.workspaceId).toBe("workspace-forked");
  });
});

describe("listWorkspaceBackedSessions", () => {
  it("maps workspace metadata into ACP session list format", async () => {
    const listMock = vi.fn().mockResolvedValue([
      makeWorkspaceMetadata({
        id: "workspace-old",
        name: "old-branch",
        title: undefined,
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      makeWorkspaceMetadata({
        id: "workspace-new",
        name: "new-branch",
        title: "New Workspace",
        projectPath: "/repo",
        createdAt: "2026-02-01T00:00:00.000Z",
        unarchivedAt: "2026-02-15T08:30:00.000Z",
      }),
      makeWorkspaceMetadata({
        id: "workspace-other-project",
        projectPath: "/other",
      }),
    ]);

    const client = makeClient({ list: listMock });

    const response = await listWorkspaceBackedSessions(client, {
      cwd: "/repo/",
    });

    expect(response).toEqual({
      sessions: [
        {
          sessionId: "workspace-new",
          cwd: "/repo",
          title: "New Workspace",
          updatedAt: "2026-02-15T08:30:00.000Z",
        },
        {
          sessionId: "workspace-old",
          cwd: "/repo",
          title: "old-branch",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("sorts sessions by updatedAt recency rather than createdAt", async () => {
    const listMock = vi.fn().mockResolvedValue([
      makeWorkspaceMetadata({
        id: "workspace-restored",
        name: "restored-branch",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        unarchivedAt: "2026-03-01T12:00:00.000Z",
      }),
      makeWorkspaceMetadata({
        id: "workspace-recent-created",
        name: "recent-created",
        projectPath: "/repo",
        createdAt: "2026-02-15T00:00:00.000Z",
      }),
    ]);

    const client = makeClient({ list: listMock });

    const response = await listWorkspaceBackedSessions(client, {
      cwd: "/repo",
    });

    expect(response.sessions.map((session) => session.sessionId)).toEqual([
      "workspace-restored",
      "workspace-recent-created",
    ]);
    expect(response.sessions[0]?.updatedAt).toBe("2026-03-01T12:00:00.000Z");
  });

  it("uses the most recent archive state timestamp for updatedAt", async () => {
    const listMock = vi.fn().mockResolvedValue([
      makeWorkspaceMetadata({
        id: "workspace-archived-recently",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        unarchivedAt: "2026-02-01T00:00:00.000Z",
        archivedAt: "2026-03-01T12:00:00.000Z",
      }),
      makeWorkspaceMetadata({
        id: "workspace-unarchived",
        projectPath: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        unarchivedAt: "2026-02-15T00:00:00.000Z",
      }),
    ]);

    const client = makeClient({ list: listMock });

    const response = await listWorkspaceBackedSessions(client, {
      cwd: "/repo",
    });

    expect(response.sessions[0]).toMatchObject({
      sessionId: "workspace-archived-recently",
      updatedAt: "2026-03-01T12:00:00.000Z",
    });
  });

  it("ignores malformed workspace paths during cwd filtering", async () => {
    const listMock = vi.fn().mockResolvedValue([
      makeWorkspaceMetadata({
        id: "workspace-valid-project-path",
        projectPath: "/repo",
        namedWorkspacePath: "relative/corrupted-path",
      }),
      makeWorkspaceMetadata({
        id: "workspace-malformed",
        projectPath: "relative/project/path",
        namedWorkspacePath: "another/relative/path",
      }),
      makeWorkspaceMetadata({
        id: "workspace-other-project",
        projectPath: "/other",
        namedWorkspacePath: "/other/.mux/workspace-other",
      }),
    ]);

    const client = makeClient({ list: listMock });

    const response = await listWorkspaceBackedSessions(client, {
      cwd: "/repo",
    });

    expect(response).toEqual({
      sessions: [
        {
          sessionId: "workspace-valid-project-path",
          cwd: "/repo",
          title: "feature/acp",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    });
  });

  it("paginates with cursor offsets", async () => {
    const workspaces = Array.from({ length: 101 }, (_, index) =>
      makeWorkspaceMetadata({
        id: `workspace-${index}`,
        projectPath: "/repo",
        createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
      })
    );

    const listMock = vi.fn().mockResolvedValue(workspaces);
    const client = makeClient({ list: listMock });

    const firstPage = await listWorkspaceBackedSessions(client, {});
    expect(firstPage.sessions).toHaveLength(100);
    expect(firstPage.nextCursor).toBe("100");

    const secondPage = await listWorkspaceBackedSessions(client, { cursor: "100" });
    expect(secondPage.sessions).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
  });
});
