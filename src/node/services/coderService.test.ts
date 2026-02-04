import { EventEmitter } from "events";
import { Readable } from "stream";
import { describe, it, expect, vi, beforeEach, afterEach, spyOn } from "bun:test";
import { CoderService, compareVersions } from "./coderService";
import * as childProcess from "child_process";
import * as disposableExec from "@/node/utils/disposableExec";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

/**
 * Mock execAsync for non-streaming tests.
 * Uses spyOn instead of vi.mock to avoid polluting other test files.
 */
let execAsyncSpy: ReturnType<typeof spyOn<typeof disposableExec, "execAsync">> | null = null;

// Minimal mock that satisfies the interface used by CoderService
// Uses cast via `unknown` because we only implement the subset actually used by tests
function createMockExecResult(
  result: Promise<{ stdout: string; stderr: string }>
): ReturnType<typeof disposableExec.execAsync> {
  const mock = {
    result,
    get promise() {
      return result;
    },
    child: {}, // not used by CoderService
    [Symbol.dispose]: noop,
  };
  return mock as unknown as ReturnType<typeof disposableExec.execAsync>;
}

function mockExecOk(stdout: string, stderr = ""): void {
  execAsyncSpy?.mockReturnValue(createMockExecResult(Promise.resolve({ stdout, stderr })));
}

function mockExecError(error: Error): void {
  execAsyncSpy?.mockReturnValue(createMockExecResult(Promise.reject(error)));
}

function mockVersionAndWhoami(options: { version: string; username?: string }): void {
  execAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
  );
  execAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(
      Promise.resolve({ stdout: JSON.stringify({ version: options.version }), stderr: "" })
    )
  );
  const whoamiPayload = {
    url: "https://coder.example.com",
    ...(options.username ? { username: options.username } : {}),
  };
  execAsyncSpy?.mockImplementationOnce(() =>
    createMockExecResult(Promise.resolve({ stdout: JSON.stringify([whoamiPayload]), stderr: "" }))
  );
}

/**
 * Mock spawn for streaming createWorkspace() tests.
 * Uses spyOn instead of vi.mock to avoid polluting other test files.
 */
let spawnSpy: ReturnType<typeof spyOn<typeof childProcess, "spawn">> | null = null;

function mockCoderCommandResult(options: {
  stdout?: string;
  stderr?: string;
  exitCode: number;
}): void {
  const stdout = Readable.from(options.stdout ? [Buffer.from(options.stdout)] : []);
  const stderr = Readable.from(options.stderr ? [Buffer.from(options.stderr)] : []);
  const events = new EventEmitter();

  spawnSpy?.mockReturnValue({
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as never);

  // Emit close after handlers are attached.
  setTimeout(() => events.emit("close", options.exitCode), 0);
}

describe("CoderService", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
    vi.clearAllMocks();
    // Set up spies for mocking - uses spyOn instead of vi.mock to avoid polluting other test files
    execAsyncSpy = spyOn(disposableExec, "execAsync");
    spawnSpy = spyOn(childProcess, "spawn");
  });

  afterEach(() => {
    service.clearCache();
    execAsyncSpy?.mockRestore();
    execAsyncSpy = null;
    spawnSpy?.mockRestore();
    spawnSpy = null;
  });

  describe("getCoderInfo", () => {
    it("returns available state with valid version", async () => {
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.28.2",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns available state for exact minimum version", async () => {
      mockVersionAndWhoami({ version: "2.25.0", username: "coder-user" });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.25.0",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns outdated state for version below minimum", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.24.9" }), stderr: "" })
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "outdated",
        version: "2.24.9",
        minVersion: "2.25.0",
        binaryPath: "/usr/local/bin/coder",
      });
    });

    it("returns outdated state without binaryPath when lookup fails", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("lookup failed")))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.24.9" }), stderr: "" })
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toEqual({ state: "outdated", version: "2.24.9", minVersion: "2.25.0" });
    });
    it("handles version with dev suffix", async () => {
      mockVersionAndWhoami({
        version: "2.28.2-devel+903c045b9",
        username: "coder-user",
      });

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "available",
        version: "2.28.2-devel+903c045b9",
        username: "coder-user",
        url: "https://coder.example.com",
      });
    });

    it("returns unavailable state with not-logged-in reason when whoami fails", async () => {
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.reject(
            new Error(
              `Encountered an error running "coder whoami", see "coder whoami --help" for more information\nerror: You are not logged in. Try logging in using 'coder login <url>'.`
            )
          )
        )
      );

      const info = await service.getCoderInfo();

      expect(info).toMatchObject({
        state: "unavailable",
        reason: { kind: "not-logged-in" },
      });

      if (
        info.state !== "unavailable" ||
        typeof info.reason === "string" ||
        info.reason.kind !== "not-logged-in"
      ) {
        throw new Error(`Expected not-logged-in unavailable state, got: ${JSON.stringify(info)}`);
      }

      expect(info.reason.message).toContain("/usr/local/bin/coder");
      expect(info.reason.message.toLowerCase()).toContain("not logged in");
    });

    it("re-checks whoami after transient failure (does not cache error state)", async () => {
      // First call: whoami transient error
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("error: Connection refused")))
      );

      // Second call: should try again (previous error must not be cached)
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.reject(new Error("error: Connection refused")))
      );

      const first = await service.getCoderInfo();
      expect(first).toMatchObject({ state: "unavailable", reason: { kind: "error" } });

      if (
        first.state !== "unavailable" ||
        typeof first.reason === "string" ||
        first.reason.kind !== "error"
      ) {
        throw new Error(`Expected unavailable error state, got: ${JSON.stringify(first)}`);
      }

      expect(first.reason.message.toLowerCase()).toContain("connection refused");

      const second = await service.getCoderInfo();
      expect(second).toMatchObject({ state: "unavailable", reason: { kind: "error" } });

      const cmds = execAsyncSpy?.mock.calls.map(([cmd]) => cmd) ?? [];
      expect(cmds.filter((c) => c === "coder whoami --output=json")).toHaveLength(2);
    });

    it("re-checks login status after not-logged-in and caches once logged in", async () => {
      // First call: not logged in
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(Promise.resolve({ stdout: "/usr/local/bin/coder\n", stderr: "" }))
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.resolve({ stdout: JSON.stringify({ version: "2.28.2" }), stderr: "" })
        )
      );
      execAsyncSpy?.mockImplementationOnce(() =>
        createMockExecResult(
          Promise.reject(
            new Error(
              `Encountered an error running "coder whoami", see "coder whoami --help" for more information\nerror: You are not logged in. Try logging in using 'coder login <url>'.`
            )
          )
        )
      );

      // Second call: now logged in
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      const first = await service.getCoderInfo();
      expect(first).toMatchObject({
        state: "unavailable",
        reason: { kind: "not-logged-in" },
      });

      if (
        first.state !== "unavailable" ||
        typeof first.reason === "string" ||
        first.reason.kind !== "not-logged-in"
      ) {
        throw new Error(`Expected not-logged-in unavailable state, got: ${JSON.stringify(first)}`);
      }

      expect(first.reason.message).toContain("/usr/local/bin/coder");
      expect(first.reason.message.toLowerCase()).toContain("not logged in");

      const second = await service.getCoderInfo();
      expect(second).toEqual({
        state: "available",
        version: "2.28.2",
        username: "coder-user",
        url: "https://coder.example.com",
      });

      const callsAfterSecond = execAsyncSpy?.mock.calls.length ?? 0;

      // Third call should come from cache (no extra execAsync calls)
      await service.getCoderInfo();
      expect(execAsyncSpy?.mock.calls.length ?? 0).toBe(callsAfterSecond);

      const cmds = execAsyncSpy?.mock.calls.map(([cmd]) => cmd) ?? [];
      expect(cmds.filter((c) => c === "coder whoami --output=json")).toHaveLength(2);
    });

    it("returns unavailable state with reason missing when CLI not installed", async () => {
      mockExecError(new Error("command not found: coder"));

      const info = await service.getCoderInfo();

      expect(info).toEqual({ state: "unavailable", reason: "missing" });
    });

    it("returns unavailable state with error reason for other errors", async () => {
      mockExecError(new Error("Connection refused"));

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "unavailable",
        reason: { kind: "error", message: "Connection refused" },
      });
    });

    it("returns unavailable state with error when version is missing from output", async () => {
      mockExecOk(JSON.stringify({}));

      const info = await service.getCoderInfo();

      expect(info).toEqual({
        state: "unavailable",
        reason: { kind: "error", message: "Version output missing from CLI" },
      });
    });

    it("caches the result", async () => {
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });

      await service.getCoderInfo();
      await service.getCoderInfo();

      expect(execAsyncSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe("listTemplates", () => {
    it("returns templates with display names", async () => {
      execAsyncSpy?.mockReturnValue(
        createMockExecResult(
          Promise.resolve({
            stdout: JSON.stringify([
              {
                Template: {
                  name: "template-1",
                  display_name: "Template One",
                  organization_name: "org1",
                },
              },
              { Template: { name: "template-2", display_name: "Template Two" } },
            ]),
            stderr: "",
          })
        )
      );

      const templates = await service.listTemplates();

      expect(templates).toEqual({
        ok: true,
        templates: [
          { name: "template-1", displayName: "Template One", organizationName: "org1" },
          { name: "template-2", displayName: "Template Two", organizationName: "default" },
        ],
      });
    });

    it("uses name as displayName when display_name not present", async () => {
      execAsyncSpy?.mockReturnValue(
        createMockExecResult(
          Promise.resolve({
            stdout: JSON.stringify([{ Template: { name: "my-template" } }]),
            stderr: "",
          })
        )
      );

      const templates = await service.listTemplates();

      expect(templates).toEqual({
        ok: true,
        templates: [
          { name: "my-template", displayName: "my-template", organizationName: "default" },
        ],
      });
    });

    it("returns error result on error", async () => {
      mockExecError(new Error("not logged in"));

      const templates = await service.listTemplates();

      expect(templates).toEqual({ ok: false, error: "not logged in" });
    });

    it("returns empty array for empty output", async () => {
      mockExecOk("");

      const templates = await service.listTemplates();

      expect(templates).toEqual({ ok: true, templates: [] });
    });
  });

  describe("listPresets", () => {
    it("returns presets for a template", async () => {
      mockExecOk(
        JSON.stringify([
          {
            TemplatePreset: {
              ID: "preset-1",
              Name: "Small",
              Description: "Small instance",
              Default: true,
            },
          },
          {
            TemplatePreset: {
              ID: "preset-2",
              Name: "Large",
              Description: "Large instance",
            },
          },
        ])
      );

      const presets = await service.listPresets("my-template");

      expect(presets).toEqual({
        ok: true,
        presets: [
          { id: "preset-1", name: "Small", description: "Small instance", isDefault: true },
          { id: "preset-2", name: "Large", description: "Large instance", isDefault: false },
        ],
      });
    });

    it("returns empty array when template has no presets", async () => {
      mockExecOk("");

      const presets = await service.listPresets("no-presets-template");

      expect(presets).toEqual({ ok: true, presets: [] });
    });

    it("returns error result on error", async () => {
      mockExecError(new Error("template not found"));

      const presets = await service.listPresets("nonexistent");

      expect(presets).toEqual({ ok: false, error: "template not found" });
    });
  });

  describe("listWorkspaces", () => {
    it("returns all workspaces regardless of status", async () => {
      mockExecOk(
        JSON.stringify([
          {
            name: "ws-1",
            template_name: "t1",
            template_display_name: "t1",
            latest_build: { status: "running" },
          },
          {
            name: "ws-2",
            template_name: "t2",
            template_display_name: "t2",
            latest_build: { status: "stopped" },
          },
          {
            name: "ws-3",
            template_name: "t3",
            template_display_name: "t3",
            latest_build: { status: "starting" },
          },
        ])
      );

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual({
        ok: true,
        workspaces: [
          { name: "ws-1", templateName: "t1", templateDisplayName: "t1", status: "running" },
          { name: "ws-2", templateName: "t2", templateDisplayName: "t2", status: "stopped" },
          { name: "ws-3", templateName: "t3", templateDisplayName: "t3", status: "starting" },
        ],
      });
    });

    it("returns error result on failure", async () => {
      mockExecError(
        new Error(
          `Encountered an error running "coder list", see "coder list --help" for more information\nerror: You are not logged in. Try logging in using '/usr/local/bin/coder login <url>'.`
        )
      );

      const workspaces = await service.listWorkspaces();

      expect(workspaces).toEqual({
        ok: false,
        error: "You are not logged in. Try logging in using '/usr/local/bin/coder login <url>'.",
      });
    });
  });

  describe("workspaceExists", () => {
    it("returns true when exact match is found in search results", async () => {
      mockExecOk(JSON.stringify([{ name: "ws-1" }, { name: "ws-10" }]));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(true);
    });

    it("returns false when only prefix matches", async () => {
      mockExecOk(JSON.stringify([{ name: "ws-10" }]));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(false);
    });

    it("returns false on CLI error", async () => {
      mockExecError(new Error("not logged in"));

      const exists = await service.workspaceExists("ws-1");

      expect(exists).toBe(false);
    });
  });

  describe("getWorkspaceStatus", () => {
    it("returns status for exact match (search is prefix-based)", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([
          { name: "ws-1", latest_build: { status: "running" } },
          { name: "ws-10", latest_build: { status: "stopped" } },
        ]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.status).toBe("running");
      }
    });

    it("returns not_found when only prefix matches", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([{ name: "ws-10", latest_build: { status: "running" } }]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("not_found");
    });

    it("returns error for unknown workspace status", async () => {
      mockCoderCommandResult({
        exitCode: 0,
        stdout: JSON.stringify([{ name: "ws-1", latest_build: { status: "weird" } }]),
      });

      const result = await service.getWorkspaceStatus("ws-1");

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error).toContain("Unknown status");
      }
    });
  });

  describe("waitForStartupScripts", () => {
    it("streams stdout/stderr lines while waiting", async () => {
      const stdout = Readable.from([Buffer.from("Waiting for agent...\nAgent ready\n")]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 0), 0);

      const lines: string[] = [];
      for await (const line of service.waitForStartupScripts("my-ws")) {
        lines.push(line);
      }

      expect(lines).toContain("$ coder ssh my-ws --wait=yes -- true");
      expect(lines).toContain("Waiting for agent...");
      expect(lines).toContain("Agent ready");
      expect(spawnSpy).toHaveBeenCalledWith("coder", ["ssh", "my-ws", "--wait=yes", "--", "true"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    });

    it("throws when exit code is non-zero", async () => {
      const stdout = Readable.from([]);
      const stderr = Readable.from([Buffer.from("Connection refused\n")]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 1), 0);

      const lines: string[] = [];
      const run = async () => {
        for await (const line of service.waitForStartupScripts("my-ws")) {
          lines.push(line);
        }
      };

      let thrown: unknown;
      try {
        await run();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toBe(
        "coder ssh --wait failed (exit 1): Connection refused"
      );
    });
  });

  describe("fetchDeploymentSshConfig", () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    function mockWhoami() {
      execAsyncSpy?.mockImplementation((cmd: string) => {
        if (cmd === "coder whoami --output=json") {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { url: "https://coder.example.com", username: "coder-user" },
              ]),
              stderr: "",
            })
          );
        }
        return createMockExecResult(Promise.reject(new Error(`Unexpected command: ${cmd}`)));
      });
    }

    it("uses provided session and normalizes leading dot", async () => {
      mockWhoami();
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hostname_suffix: ".corp" }),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      const session = {
        token: "session-token",
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const result = await service.fetchDeploymentSshConfig(session);

      expect(result).toEqual({ hostnameSuffix: "corp" });
      const calledUrl = fetchSpy.mock.calls[0]?.[0] as URL | undefined;
      const options = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(calledUrl?.toString()).toBe("https://coder.example.com/api/v2/deployment/ssh");
      expect(options).toEqual({
        headers: { "Coder-Session-Token": "session-token" },
      });
      expect(execAsyncSpy).toHaveBeenCalledTimes(1);
    });

    it("reuses cached whoami after getCoderInfo", async () => {
      mockVersionAndWhoami({ version: "2.28.2", username: "coder-user" });
      execAsyncSpy?.mockImplementation((cmd: string) =>
        createMockExecResult(Promise.reject(new Error(`Unexpected command: ${cmd}`)))
      );
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ hostname_suffix: ".corp" }),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      await service.getCoderInfo();

      const session = {
        token: "session-token",
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      await service.fetchDeploymentSshConfig(session);

      expect(execAsyncSpy).toHaveBeenCalledTimes(3);
      const whoamiCalls =
        execAsyncSpy?.mock.calls.filter(([cmd]) => cmd === "coder whoami --output=json") ?? [];
      expect(whoamiCalls).toHaveLength(1);
    });

    it("defaults to coder when hostname suffix missing", async () => {
      mockWhoami();
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      global.fetch = fetchSpy as unknown as typeof fetch;

      const session = {
        token: "session-token",
        dispose: vi.fn().mockResolvedValue(undefined),
      };
      const result = await service.fetchDeploymentSshConfig(session);

      expect(result).toEqual({ hostnameSuffix: "coder" });
    });
  });

  describe("provisioning sessions", () => {
    function mockTokenCommands() {
      execAsyncSpy?.mockImplementation((cmd: string) => {
        if (cmd.startsWith("coder tokens create --lifetime 5m --name")) {
          return createMockExecResult(Promise.resolve({ stdout: "token-123", stderr: "" }));
        }
        if (cmd.startsWith("coder tokens delete")) {
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }
        return createMockExecResult(Promise.reject(new Error(`Unexpected command: ${cmd}`)));
      });
    }

    it("reuses provisioning sessions for the same workspace", async () => {
      mockTokenCommands();
      const session1 = await service.ensureProvisioningSession("ws");
      const session2 = await service.ensureProvisioningSession("ws");

      expect(session1).toBe(session2);
      expect(session1.token).toBe("token-123");

      await service.disposeProvisioningSession("ws");
      expect(execAsyncSpy).toHaveBeenCalledTimes(2);
    });

    it("takeProvisioningSession returns and clears the session", async () => {
      mockTokenCommands();
      const session = await service.ensureProvisioningSession("ws");
      const taken = service.takeProvisioningSession("ws");

      expect(taken).toBe(session);
      expect(service.takeProvisioningSession("ws")).toBeUndefined();

      await taken?.dispose();
      expect(execAsyncSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("createWorkspace", () => {
    // Capture original fetch once per describe block to avoid nested mock issues
    let originalFetch: typeof fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    // Helper to mock the pre-fetch calls that happen before spawn
    function mockPrefetchCalls(options?: { presetParamNames?: string[] }) {
      // Mock getDeploymentUrl (coder whoami)
      // Mock getActiveTemplateVersionId (coder templates list)
      // Mock getPresetParamNames (coder templates presets list)
      // Mock getTemplateRichParameters (coder tokens create + fetch)
      execAsyncSpy?.mockImplementation((cmd: string) => {
        if (cmd === "coder whoami --output=json") {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { url: "https://coder.example.com", username: "coder-user" },
              ]),
              stderr: "",
            })
          );
        }
        if (cmd === "coder templates list --output=json") {
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                { Template: { name: "my-template", active_version_id: "version-123" } },
                { Template: { name: "tmpl", active_version_id: "version-456" } },
              ]),
              stderr: "",
            })
          );
        }
        if (cmd.startsWith("coder templates presets list")) {
          const paramNames = options?.presetParamNames ?? [];
          return createMockExecResult(
            Promise.resolve({
              stdout: JSON.stringify([
                {
                  TemplatePreset: {
                    Name: "preset",
                    Parameters: paramNames.map((name) => ({ Name: name })),
                  },
                },
              ]),
              stderr: "",
            })
          );
        }
        if (cmd.startsWith("coder tokens create --lifetime 5m --name")) {
          return createMockExecResult(Promise.resolve({ stdout: "fake-token-123", stderr: "" }));
        }
        if (cmd.startsWith("coder tokens delete")) {
          return createMockExecResult(Promise.resolve({ stdout: "", stderr: "" }));
        }
        // Fallback for any other command
        return createMockExecResult(Promise.reject(new Error(`Unexpected command: ${cmd}`)));
      });
    }

    // Helper to mock fetch for rich parameters API
    function mockFetchRichParams(
      params: Array<{
        name: string;
        default_value: string;
        ephemeral?: boolean;
        required?: boolean;
      }>
    ) {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(params),
      }) as unknown as typeof fetch;
    }

    it("streams stdout/stderr lines and passes expected args", async () => {
      mockPrefetchCalls();
      mockFetchRichParams([]);

      const stdout = Readable.from([Buffer.from("out-1\nout-2\n")]);
      const stderr = Readable.from([Buffer.from("err-1\n")]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      // Emit close after handlers are attached.
      setTimeout(() => events.emit("close", 0), 0);

      const lines: string[] = [];
      for await (const line of service.createWorkspace("my-workspace", "my-template")) {
        lines.push(line);
      }

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        ["create", "my-workspace", "-t", "my-template", "--yes"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );

      // First line is the command, rest are stdout/stderr
      expect(lines[0]).toBe("$ coder create my-workspace -t my-template --yes");
      expect(lines.slice(1).sort()).toEqual(["err-1", "out-1", "out-2"]);
    });

    it("includes --preset when provided", async () => {
      mockPrefetchCalls({ presetParamNames: ["covered-param"] });
      mockFetchRichParams([{ name: "covered-param", default_value: "val" }]);

      const stdout = Readable.from([]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 0), 0);

      for await (const _line of service.createWorkspace("ws", "tmpl", "preset")) {
        // drain
      }

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        ["create", "ws", "-t", "tmpl", "--yes", "--preset", "preset"],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("includes --parameter flags for uncovered non-ephemeral params", async () => {
      mockPrefetchCalls({ presetParamNames: ["covered-param"] });
      mockFetchRichParams([
        { name: "covered-param", default_value: "val1" },
        { name: "uncovered-param", default_value: "val2" },
        { name: "ephemeral-param", default_value: "val3", ephemeral: true },
      ]);

      const stdout = Readable.from([]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 0), 0);

      for await (const _line of service.createWorkspace("ws", "tmpl", "preset")) {
        // drain
      }

      expect(spawnSpy).toHaveBeenCalledWith(
        "coder",
        [
          "create",
          "ws",
          "-t",
          "tmpl",
          "--yes",
          "--preset",
          "preset",
          "--parameter",
          "uncovered-param=val2",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    it("throws when exit code is non-zero", async () => {
      mockPrefetchCalls();
      mockFetchRichParams([]);

      const stdout = Readable.from([]);
      const stderr = Readable.from([]);
      const events = new EventEmitter();

      spawnSpy!.mockReturnValue({
        stdout,
        stderr,
        kill: vi.fn(),
        on: events.on.bind(events),
      } as never);

      setTimeout(() => events.emit("close", 42), 0);

      let thrown: unknown;
      try {
        for await (const _line of service.createWorkspace("ws", "tmpl")) {
          // drain
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain(
        "coder create failed (exit 42)"
      );
    });

    it("aborts before spawn when already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      let thrown: unknown;
      try {
        for await (const _line of service.createWorkspace(
          "ws",
          "tmpl",
          undefined,
          abortController.signal
        )) {
          // drain
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("aborted");
    });

    it("throws when required param has no default and is not covered by preset", async () => {
      mockPrefetchCalls({ presetParamNames: [] });
      mockFetchRichParams([{ name: "required-param", default_value: "", required: true }]);

      let thrown: unknown;
      try {
        for await (const _line of service.createWorkspace("ws", "tmpl")) {
          // drain
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeTruthy();
      expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("required-param");
    });
  });
});

describe("computeExtraParams", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("returns empty array when all params are covered by preset", () => {
    const params = [
      { name: "param1", defaultValue: "val1", type: "string", ephemeral: false, required: false },
      { name: "param2", defaultValue: "val2", type: "string", ephemeral: false, required: false },
    ];
    const covered = new Set(["param1", "param2"]);

    expect(service.computeExtraParams(params, covered)).toEqual([]);
  });

  it("returns uncovered non-ephemeral params with defaults", () => {
    const params = [
      { name: "covered", defaultValue: "val1", type: "string", ephemeral: false, required: false },
      {
        name: "uncovered",
        defaultValue: "val2",
        type: "string",
        ephemeral: false,
        required: false,
      },
    ];
    const covered = new Set(["covered"]);

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "uncovered", encoded: "uncovered=val2" },
    ]);
  });

  it("excludes ephemeral params", () => {
    const params = [
      { name: "normal", defaultValue: "val1", type: "string", ephemeral: false, required: false },
      { name: "ephemeral", defaultValue: "val2", type: "string", ephemeral: true, required: false },
    ];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "normal", encoded: "normal=val1" },
    ]);
  });

  it("includes params with empty default values", () => {
    const params = [
      {
        name: "empty-default",
        defaultValue: "",
        type: "string",
        ephemeral: false,
        required: false,
      },
    ];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "empty-default", encoded: "empty-default=" },
    ]);
  });

  it("CSV-encodes list(string) values containing quotes", () => {
    const params = [
      {
        name: "Select IDEs",
        defaultValue: '["vscode","code-server","cursor"]',
        type: "list(string)",
        ephemeral: false,
        required: false,
      },
    ];
    const covered = new Set<string>();

    // CLI uses CSV parsing, so quotes need escaping: " -> ""
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "Select IDEs", encoded: '"Select IDEs=[""vscode"",""code-server"",""cursor""]"' },
    ]);
  });

  it("passes empty list(string) array without CSV encoding", () => {
    const params = [
      {
        name: "empty-list",
        defaultValue: "[]",
        type: "list(string)",
        ephemeral: false,
        required: false,
      },
    ];
    const covered = new Set<string>();

    // No quotes or commas, so no encoding needed
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "empty-list", encoded: "empty-list=[]" },
    ]);
  });
});

describe("validateRequiredParams", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("does not throw when all required params have defaults", () => {
    const params = [
      {
        name: "required-with-default",
        defaultValue: "val",
        type: "string",
        ephemeral: false,
        required: true,
      },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("does not throw when required params are covered by preset", () => {
    const params = [
      {
        name: "required-no-default",
        defaultValue: "",
        type: "string",
        ephemeral: false,
        required: true,
      },
    ];
    const covered = new Set(["required-no-default"]);

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("throws when required param has no default and is not covered", () => {
    const params = [
      { name: "missing-param", defaultValue: "", type: "string", ephemeral: false, required: true },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).toThrow("missing-param");
  });

  it("ignores ephemeral required params", () => {
    const params = [
      {
        name: "ephemeral-required",
        defaultValue: "",
        type: "string",
        ephemeral: true,
        required: true,
      },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("lists all missing required params in error", () => {
    const params = [
      { name: "missing1", defaultValue: "", type: "string", ephemeral: false, required: true },
      { name: "missing2", defaultValue: "", type: "string", ephemeral: false, required: true },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).toThrow(
      /missing1.*missing2|missing2.*missing1/
    );
  });
});

describe("non-string parameter defaults", () => {
  let service: CoderService;

  beforeEach(() => {
    service = new CoderService();
  });

  it("validateRequiredParams passes when required param has numeric default 0", () => {
    // After parseRichParameters, numeric 0 becomes "0" (not "")
    const params = [
      { name: "count", defaultValue: "0", type: "number", ephemeral: false, required: true },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("validateRequiredParams passes when required param has boolean default false", () => {
    // After parseRichParameters, boolean false becomes "false" (not "")
    const params = [
      { name: "enabled", defaultValue: "false", type: "bool", ephemeral: false, required: true },
    ];
    const covered = new Set<string>();

    expect(() => service.validateRequiredParams(params, covered)).not.toThrow();
  });

  it("computeExtraParams emits numeric default correctly", () => {
    const params = [
      { name: "count", defaultValue: "42", type: "number", ephemeral: false, required: false },
    ];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "count", encoded: "count=42" },
    ]);
  });

  it("computeExtraParams emits boolean default correctly", () => {
    const params = [
      { name: "enabled", defaultValue: "true", type: "bool", ephemeral: false, required: false },
    ];
    const covered = new Set<string>();

    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "enabled", encoded: "enabled=true" },
    ]);
  });

  it("computeExtraParams emits array default as JSON with CSV encoding", () => {
    // After parseRichParameters, array becomes JSON string
    const params = [
      {
        name: "tags",
        defaultValue: '["a","b"]',
        type: "list(string)",
        ephemeral: false,
        required: false,
      },
    ];
    const covered = new Set<string>();

    // JSON array with quotes gets CSV-encoded (quotes escaped as "")
    expect(service.computeExtraParams(params, covered)).toEqual([
      { name: "tags", encoded: '"tags=[""a"",""b""]"' },
    ]);
  });
});

describe("deleteWorkspace", () => {
  const service = new CoderService();
  let mockExec: ReturnType<typeof spyOn<typeof disposableExec, "execAsync">> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExec = spyOn(disposableExec, "execAsync");
  });

  afterEach(() => {
    mockExec?.mockRestore();
    mockExec = null;
  });

  it("refuses to delete workspace without mux- prefix", async () => {
    await service.deleteWorkspace("my-workspace");

    // Should not call execAsync at all
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("deletes workspace with mux- prefix", async () => {
    mockExec?.mockReturnValue(createMockExecResult(Promise.resolve({ stdout: "", stderr: "" })));

    await service.deleteWorkspace("mux-my-workspace");

    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("coder delete"));
    expect(mockExec).toHaveBeenCalledWith(expect.stringContaining("mux-my-workspace"));
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("2.28.6", "2.28.6")).toBe(0);
  });

  it("returns 0 for equal versions with different formats", () => {
    expect(compareVersions("v2.28.6", "2.28.6")).toBe(0);
    expect(compareVersions("v2.28.6+hash", "2.28.6")).toBe(0);
  });

  it("returns negative when first version is older", () => {
    expect(compareVersions("2.25.0", "2.28.6")).toBeLessThan(0);
    expect(compareVersions("2.28.5", "2.28.6")).toBeLessThan(0);
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when first version is newer", () => {
    expect(compareVersions("2.28.6", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("2.28.6", "2.28.5")).toBeGreaterThan(0);
    expect(compareVersions("3.0.0", "2.28.6")).toBeGreaterThan(0);
  });

  it("handles versions with v prefix", () => {
    expect(compareVersions("v2.28.6", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.25.0", "v2.28.6")).toBeLessThan(0);
  });

  it("handles dev versions correctly", () => {
    // v2.28.2-devel+903c045b9 should be compared as 2.28.2
    expect(compareVersions("v2.28.2-devel+903c045b9", "2.25.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.28.2-devel+903c045b9", "2.28.2")).toBe(0);
  });

  it("handles missing patch version", () => {
    expect(compareVersions("2.28", "2.28.0")).toBe(0);
    expect(compareVersions("2.28", "2.28.1")).toBeLessThan(0);
  });
});
