import { describe, expect, it, vi } from "bun:test";
import type * as schema from "@agentclientprotocol/sdk";
import type { RouterClient } from "@orpc/server";
import type { FrontendWorkspaceMetadataSchemaType } from "@/common/orpc/types";
import { resolveModelAlias } from "@/common/utils/ai/models";
import type { AppRouter } from "@/node/orpc/router";
import {
  createWorkspaceBackedSession,
  forkWorkspaceBackedSession,
  listWorkspaceBackedSessions,
  parseMuxMeta,
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
}): RouterClient<AppRouter> {
  return {
    workspace: {
      create: overrides.create ?? vi.fn(),
      list: overrides.list ?? vi.fn(),
      getInfo: overrides.getInfo ?? vi.fn(),
      fork: overrides.fork ?? vi.fn(),
    },
  } as unknown as RouterClient<AppRouter>;
}

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
