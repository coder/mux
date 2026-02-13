import { describe, expect, test } from "bun:test";

import {
  AgentSkillTransientDiscoveryError,
  type DiscoverAgentSkillsDiagnosticsResult,
} from "@/node/services/agentSkills/agentSkillsService";
import {
  getAgentSkillsDiscoveryCacheKey,
  loadAgentSkillsDiagnosticsWithFallback,
} from "./agentSkillsDiagnosticsCache";

describe("agentSkillsDiagnosticsCache", () => {
  test("reuses cached diagnostics after a transient discovery failure", async () => {
    const cache = new Map<string, DiscoverAgentSkillsDiagnosticsResult>();
    const cacheKey = getAgentSkillsDiscoveryCacheKey({
      workspaceId: "workspace-1",
      disableWorkspaceAgents: true,
    });

    const freshDiagnostics = {
      skills: [
        {
          name: "pull-requests",
          description: "PR workflow",
          scope: "project" as const,
        },
      ],
      invalidSkills: [],
    };

    const seeded = await loadAgentSkillsDiagnosticsWithFallback({
      cache,
      cacheKey,
      discover: () => Promise.resolve(freshDiagnostics),
    });
    expect(seeded).toBe(freshDiagnostics);

    const fallback = await loadAgentSkillsDiagnosticsWithFallback({
      cache,
      cacheKey,
      discover: () =>
        Promise.reject(
          new AgentSkillTransientDiscoveryError("SSH connection to host is in backoff")
        ),
    });

    expect(fallback).toBe(freshDiagnostics);
  });

  test("does not hide non-transient discovery failures", async () => {
    const cache = new Map<string, DiscoverAgentSkillsDiagnosticsResult>();
    const cacheKey = getAgentSkillsDiscoveryCacheKey({ projectPath: "/repo" });

    await loadAgentSkillsDiagnosticsWithFallback({
      cache,
      cacheKey,
      discover: () => Promise.resolve({ skills: [], invalidSkills: [] }),
    });

    let caught: unknown;
    try {
      await loadAgentSkillsDiagnosticsWithFallback({
        cache,
        cacheKey,
        discover: () => Promise.reject(new Error("SKILL.md has invalid frontmatter")),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) {
      throw new Error("expected an error to be thrown");
    }
    expect(caught.message).toContain("invalid frontmatter");
  });

  test("rethrows transient discovery errors when no cache exists", async () => {
    const cache = new Map<string, DiscoverAgentSkillsDiagnosticsResult>();
    const cacheKey = getAgentSkillsDiscoveryCacheKey({ projectPath: "/repo" });

    let caught: unknown;
    try {
      await loadAgentSkillsDiagnosticsWithFallback({
        cache,
        cacheKey,
        discover: () =>
          Promise.reject(new AgentSkillTransientDiscoveryError("Connection timed out")),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentSkillTransientDiscoveryError);
  });
});
