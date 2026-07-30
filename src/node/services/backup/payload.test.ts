import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import {
  REDACTED_BACKUP_VALUE,
  createBackupPayload,
  readBackupPayload,
  restoreBackupPayload,
  scanBackupFilesForSecrets,
  writeBackupPayload,
} from "./payload";

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function payloadFileText(
  payload: Awaited<ReturnType<typeof createBackupPayload>>,
  relativePath: string
): string {
  const file = payload.files.find((candidate) => candidate.path === relativePath);
  if (file === undefined) throw new Error(`Missing payload file '${relativePath}'`);
  return file.content.toString("utf-8");
}

describe("backup payload", () => {
  let tempDir: string;
  let muxRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-backup-payload-"));
    muxRoot = path.join(tempDir, "mux-root");
    await fs.mkdir(muxRoot);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("collects only explicitly allowed files and preferences", async () => {
    await write(muxRoot, "AGENTS.md", "shared instructions\n");
    await write(muxRoot, "AGENTS.local.md", "private instructions\n");
    await write(muxRoot, "agents/reviewer.md", "reviewer\n");
    await write(muxRoot, "agents/notes.txt", "not an agent\n");
    await write(muxRoot, "agents/nested/hidden.md", "nested agent\n");
    await write(muxRoot, "skills/review/SKILL.md", "skill\n");
    await write(muxRoot, "skills/review/providers.jsonc", "{}\n");
    await write(muxRoot, "memory/global/note.md", "memory\n");
    await write(muxRoot, "memory/global/memory-meta.json", "{}\n");
    for (const secretFile of [
      "providers.jsonc",
      "secrets.json",
      "mcp-oauth.json",
      "server.lock",
      "serverAuthSessions.json",
    ]) {
      await write(muxRoot, secretFile, "must not export\n");
    }

    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
      exportedAt: "2026-07-30T00:00:00.000Z",
      preferences: {
        appearance: { theme: "dark", vimEnabled: true },
        navigation: { launchBehavior: "dashboard", projectOrder: ["/private/project"] },
        ai: {
          globalDefaults: { agentId: "exec" },
          projectDefaults: { "/private/project": { model: "secret/model" } },
          autoCompactionThresholdByModel: { "openai/gpt": 75 },
        },
        workspaceCreation: { byProject: { "/private/project": { trunkBranch: "main" } } },
        notifications: { notifyOnResponseByWorkspace: { workspace: true } },
        review: {
          includeUncommitted: true,
          defaultBaseByProject: { "/private/project": "main" },
        },
      },
    });

    expect(payload.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "agents/reviewer.md",
      "memory/global/note.md",
      "preferences.json",
      "skills/review/SKILL.md",
    ]);
    expect(payload.manifest.files.map((file) => file.path)).toEqual(
      payload.files.map((file) => file.path)
    );
    const preferences = JSON.parse(payloadFileText(payload, "preferences.json")) as Record<
      string,
      unknown
    >;
    expect(preferences).toEqual({
      appearance: { theme: "dark", vimEnabled: true },
      navigation: { launchBehavior: "dashboard" },
      ai: {
        globalDefaults: { agentId: "exec" },
        autoCompactionThresholdByModel: { "openai/gpt": 75 },
      },
      review: { includeUncommitted: true },
    });
  });

  it("redacts literal MCP headers and inline URL tokens but keeps references", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  // Keep this comment: mcp.jsonc is a commented format.
  "servers": {
    "api": {
      "url": "https://user:password@example.com/mcp?token=literal&mode=fast",
      "headers": {
        "Authorization": "Bearer literal",
        "Secret": { "secret": "MCP_SECRET" },
        "OpObject": { "op": "op://Vault/Item/token" }
      }
    },
    "plain": {
      "url": "https://example.com/mcp?mode=fast"
    }
  }
}
`
    );

    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const mcp = jsonc.parse(payloadFileText(payload, "mcp.jsonc")) as {
      servers: {
        api: { url: string; headers: Record<string, unknown> };
        plain: { url: string };
      };
    };

    expect(mcp.servers.api.headers.Authorization).toBe(REDACTED_BACKUP_VALUE);
    expect(mcp.servers.api.headers.Secret).toEqual({ secret: "MCP_SECRET" });
    expect(mcp.servers.api.headers.OpObject).toEqual({ op: "op://Vault/Item/token" });
    expect(mcp.servers.api.url).not.toContain("password");
    expect(mcp.servers.api.url).not.toContain("token=literal");
    expect(mcp.servers.api.url).toContain("mode=fast");
    expect(mcp.servers.plain.url).toBe("https://example.com/mcp?mode=fast");
    expect(payloadFileText(payload, "mcp.jsonc")).toContain("// Keep this comment");
    const destination = path.join(tempDir, "redacted-payload");
    await writeBackupPayload(destination, payload);
    expect((await readBackupPayload(destination)).redactions).toEqual(payload.redactions);
    expect(payload.redactions).toEqual(["servers.api.headers.Authorization", "servers.api.url"]);
  });

  it("validates every path before replacing an existing payload", async () => {
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    payload.files.push({ path: "providers.jsonc", content: Buffer.from("{}\n") });
    const destination = path.join(tempDir, "existing-payload");
    await write(destination, "keep.txt", "existing\n");

    try {
      await writeBackupPayload(destination, payload);
      throw new Error("Expected disallowed path rejection");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("disallowed path");
    }
    expect(await fs.readFile(path.join(destination, "keep.txt"), "utf-8")).toBe("existing\n");
  });

  it("rejects payload paths that escape the destination on Windows", async () => {
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    payload.files.push({
      path: "skills/..\\..\\escaped.md",
      content: Buffer.from("escaped\n", "utf-8"),
    });

    try {
      await writeBackupPayload(path.join(tempDir, "escaped"), payload);
      throw new Error("Expected the traversal path to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("disallowed path");
    }
  });

  it("redacts a bare key query parameter and detects a Google API key", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      JSON.stringify({
        servers: {
          google: {
            url: "https://example.com/mcp?key=AIzaSyA12345678901234567890123456789012&mode=fast",
          },
        },
      })
    );

    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
      reportSecrets: true,
    });
    const mcp = payloadFileText(payload, "mcp.jsonc");
    expect(mcp).not.toContain("AIzaSyA12345678901234567890123456789012");
    expect(mcp).toContain(REDACTED_BACKUP_VALUE);
    expect(mcp).toContain("mode=fast");
  });

  it("flags a Google API key left in a free-form file", async () => {
    await write(muxRoot, "AGENTS.md", "key AIzaSyA12345678901234567890123456789012\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
      reportSecrets: true,
    });
    expect(scanBackupFilesForSecrets(payload.files)).toContain("AGENTS.md");
  });

  it("writes and verifies manifest hashes", async () => {
    await write(muxRoot, "AGENTS.md", "instructions\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "payload");
    await writeBackupPayload(destination, payload);

    const loaded = await readBackupPayload(destination);
    expect(payloadFileText(loaded, "AGENTS.md")).toBe("instructions\n");
    expect(loaded.redactions).toEqual(payload.redactions);

    await write(destination, "AGENTS.md", "tampered\n");
    try {
      await readBackupPayload(destination);
      throw new Error("Expected checksum rejection");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("checksum mismatch");
    }
  });

  it("blocks high-confidence secrets in free-form files", async () => {
    await write(muxRoot, "AGENTS.md", "token ghp_123456789012345678901234567890123456\n");

    try {
      await createBackupPayload({ muxRoot, muxVersion: "1.2.3", sourceLabel: "test-host" });
      throw new Error("Expected secret scan rejection");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("AGENTS.md");
    }
  });

  it("restores backed-up files without deleting local-only files or redacted MCP values", async () => {
    await write(muxRoot, "skills/shared/SKILL.md", "from backup\n");
    await write(muxRoot, "memory/global/shared.md", "backup memory\n");
    await write(
      muxRoot,
      "mcp.jsonc",
      JSON.stringify({
        servers: {
          api: {
            url: "https://backup-token@example.com/mcp?token=backup-token",
            headers: {
              Authorization: "Bearer backup-token",
              Portable: { secret: "PORTABLE_TOKEN" },
            },
          },
        },
      })
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "source",
      preferences: {
        appearance: { theme: "dark" },
        navigation: { launchBehavior: "last-workspace" },
        review: { includeUncommitted: true },
      },
    });

    const restoreRoot = path.join(tempDir, "restore-root");
    await write(restoreRoot, "skills/local/SKILL.md", "local only\n");
    await write(restoreRoot, "memory/global/local.md", "local memory\n");
    await write(
      restoreRoot,
      "mcp.jsonc",
      JSON.stringify({
        servers: {
          api: {
            url: "https://local-token@example.com/mcp?token=local-token",
            headers: {
              Authorization: "Bearer local-token",
              Portable: { secret: "OLD_TOKEN" },
            },
          },
        },
      })
    );

    const result = await restoreBackupPayload({
      muxRoot: restoreRoot,
      payload,
      currentPreferences: {
        appearance: { theme: "light", vimEnabled: true },
        navigation: { projectOrder: ["/local/project"] },
        review: { defaultBaseByProject: { "/local/project": "dev" } },
      },
    });

    expect(await fs.readFile(path.join(restoreRoot, "skills/shared/SKILL.md"), "utf-8")).toBe(
      "from backup\n"
    );
    expect(await fs.readFile(path.join(restoreRoot, "skills/local/SKILL.md"), "utf-8")).toBe(
      "local only\n"
    );
    expect(result.localOnlyFiles).toEqual(["memory/global/local.md", "skills/local/SKILL.md"]);
    expect(result.preferences).toEqual({
      appearance: { theme: "dark", vimEnabled: true },
      navigation: {
        launchBehavior: "last-workspace",
        projectOrder: ["/local/project"],
      },
      review: {
        includeUncommitted: true,
        defaultBaseByProject: { "/local/project": "dev" },
      },
    });

    const restoredMcp = jsonc.parse(
      await fs.readFile(path.join(restoreRoot, "mcp.jsonc"), "utf-8")
    ) as {
      servers: { api: { url: string; headers: Record<string, unknown> } };
    };
    expect(restoredMcp.servers.api.url).toBe(
      "https://local-token@example.com/mcp?token=local-token"
    );
    expect(restoredMcp.servers.api.headers.Authorization).toBe("Bearer local-token");
    expect(restoredMcp.servers.api.headers.Portable).toEqual({ secret: "PORTABLE_TOKEN" });
  });
});
