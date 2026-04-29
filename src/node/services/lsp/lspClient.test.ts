import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, mock } from "bun:test";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { LspClient } from "./lspClient";
import type {
  CreateLspClientOptions,
  LspPublishDiagnosticsParams,
  LspServerDescriptor,
} from "./types";

function createDescriptor(): LspServerDescriptor {
  return {
    id: "typescript",
    extensions: [".ts"],
    launch: {
      type: "manual",
      command: "fake-lsp",
      args: ["--stdio"],
    },
    rootMarkers: ["package.json", ".git"],
    languageIdForPath: () => "typescript",
  };
}

function createTransport() {
  return {
    onmessage: undefined as
      | ((message: {
          jsonrpc: "2.0";
          id?: number | string;
          method?: string;
          params?: unknown;
        }) => void)
      | undefined,
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    start: mock(() => undefined),
    send: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    isClosed: () => false,
    getStderrTail: () => "",
  };
}

type LspClientConstructor = new (
  clientOptions: CreateLspClientOptions,
  transport: ReturnType<typeof createTransport>
) => LspClient;

function createClient(options?: Partial<CreateLspClientOptions>) {
  const transport = createTransport();
  const ClientConstructor = LspClient as unknown as LspClientConstructor;
  const clientOptions: CreateLspClientOptions = {
    descriptor: createDescriptor(),
    launchPlan: {
      command: "fake-lsp",
      args: ["--stdio"],
      cwd: "/tmp/workspace",
    },
    runtime: new LocalRuntime("/tmp/workspace"),
    rootPath: "/tmp/workspace",
    rootUri: "file:///tmp/workspace",
    ...options,
  };
  const client = new ClientConstructor(clientOptions, transport);

  return {
    client,
    transport,
  };
}

describe("LspClient", () => {
  it("launches from the resolved plan and forwards initialization options", async () => {
    const requests: Array<{ id?: number | string; method?: string; params?: unknown }> = [];
    const exec = mock(
      (_command: string, _options: { cwd: string; env?: Record<string, string> }) => {
        let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            stdoutController = controller;
          },
        });
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        let resolveExitCode!: (value: number) => void;
        const exitCode = new Promise<number>((resolve) => {
          resolveExitCode = resolve;
        });
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        const stdin = new WritableStream<Uint8Array>({
          write(chunk) {
            const payload = decoder.decode(chunk);
            const headerEnd = payload.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              throw new Error(`Missing LSP frame header: ${payload}`);
            }

            const message = JSON.parse(payload.slice(headerEnd + 4)) as {
              id?: number | string;
              method?: string;
              params?: unknown;
            };
            requests.push(message);

            if (message.id == null) {
              return;
            }

            const responseBody = JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: message.method === "initialize" ? { capabilities: {} } : null,
            });
            const responseFrame = `Content-Length: ${responseBody.length}\r\n\r\n${responseBody}`;
            stdoutController.enqueue(encoder.encode(responseFrame));
          },
          close() {
            resolveExitCode(0);
          },
        });

        return Promise.resolve({
          stdout,
          stderr,
          stdin,
          exitCode,
          duration: Promise.resolve(0),
        });
      }
    );
    const runtime = new LocalRuntime("/tmp/workspace");
    runtime.exec = exec;

    const client = await LspClient.create({
      descriptor: createDescriptor(),
      launchPlan: {
        command: "/tmp/.mux/bin/typescript-language-server",
        args: ["--stdio"],
        cwd: "/tmp/workspace/.lsp",
        env: { LSP_TRACE: "verbose" },
        initializationOptions: {
          preferences: {
            includeCompletionsForModuleExports: true,
          },
        },
      },
      runtime,
      rootPath: "/tmp/workspace",
      rootUri: "file:///tmp/workspace",
    });

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]).toEqual([
      "'/tmp/.mux/bin/typescript-language-server' '--stdio'",
      {
        cwd: "/tmp/workspace/.lsp",
        env: { LSP_TRACE: "verbose" },
      },
    ]);
    expect(requests[0]?.method).toBe("initialize");
    expect(requests[0]?.params).toMatchObject({
      rootUri: "file:///tmp/workspace",
      rootPath: "/tmp/workspace",
      initializationOptions: {
        preferences: {
          includeCompletionsForModuleExports: true,
        },
      },
    });

    await client.close();
    expect(requests.at(-2)?.method).toBe("shutdown");
    expect(requests.at(-1)?.method).toBe("exit");
  });
});

describe("LspClient tracked files", () => {
  it("returns the files tracked by ensureFile without exposing internal state", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-client-"));
    try {
      const filePath = path.join(workspacePath, "src", "example.ts");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "export const value = 1;\n");

      const { client } = createClient({
        runtime: new LocalRuntime(workspacePath),
        rootPath: workspacePath,
        rootUri: `file://${workspacePath}`,
      });
      (client as unknown as { initialized: boolean }).initialized = true;

      const trackedFile = {
        runtimePath: filePath,
        readablePath: filePath,
        uri: `file://${filePath}`,
        languageId: "typescript",
      };
      await client.ensureFile(trackedFile);

      const trackedFiles = client.getTrackedFiles();
      expect(trackedFiles).toEqual([trackedFile]);

      const firstTrackedFile = trackedFiles[0];
      expect(firstTrackedFile).toBeDefined();
      if (!firstTrackedFile) {
        throw new Error("Expected ensureFile to track the opened file");
      }
      firstTrackedFile.readablePath = "/tmp/mutated.ts";
      expect(client.getTrackedFiles()).toEqual([trackedFile]);
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("sends didChange with the incremented version when ensureFile sees new content", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-client-change-"));
    try {
      const filePath = path.join(workspacePath, "src", "example.ts");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "export const value = 1;\n");

      const { client, transport } = createClient({
        runtime: new LocalRuntime(workspacePath),
        rootPath: workspacePath,
        rootUri: `file://${workspacePath}`,
      });
      (client as unknown as { initialized: boolean }).initialized = true;

      const trackedFile = {
        runtimePath: filePath,
        readablePath: filePath,
        uri: `file://${filePath}`,
        languageId: "typescript",
      };

      await client.ensureFile(trackedFile);
      await fs.writeFile(filePath, "export const value = 2;\n");
      const nextVersion = await client.ensureFile(trackedFile);

      expect(nextVersion).toBe(2);
      expect(transport.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ method: "textDocument/didOpen" })
      );
      expect(transport.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "textDocument/didChange",
          params: {
            textDocument: {
              uri: trackedFile.uri,
              version: 2,
            },
            contentChanges: [{ text: "export const value = 2;\n" }],
          },
        })
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("LspClient tracked file cleanup", () => {
  it("removes closed tracked files and notifies the server", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-client-close-"));
    try {
      const filePath = path.join(workspacePath, "src", "example.ts");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "export const value = 1;\n");

      const { client, transport } = createClient({
        runtime: new LocalRuntime(workspacePath),
        rootPath: workspacePath,
        rootUri: `file://${workspacePath}`,
      });
      (client as unknown as { initialized: boolean }).initialized = true;

      const trackedFile = {
        runtimePath: filePath,
        readablePath: filePath,
        uri: `file://${filePath}`,
        languageId: "typescript",
      };
      await client.ensureFile(trackedFile);
      await client.closeTrackedFile(trackedFile.uri);
      await client.closeTrackedFile(trackedFile.uri);

      expect(client.getTrackedFiles()).toEqual([]);
      expect(transport.send).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ method: "textDocument/didOpen" })
      );
      expect(transport.send).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ method: "textDocument/didClose" })
      );
    } finally {
      await fs.rm(workspacePath, { recursive: true, force: true });
    }
  });
});

describe("LspClient publishDiagnostics handling", () => {
  it("forwards valid publishDiagnostics notifications", () => {
    const onPublishDiagnostics = mock((_params: LspPublishDiagnosticsParams) => undefined);
    const { transport } = createClient({ onPublishDiagnostics });

    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/workspace/src/example.ts",
        version: 2,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 4 },
              end: { line: 0, character: 9 },
            },
            severity: 1,
            code: "TS2322",
            source: "tsserver",
            message: "Type 'string' is not assignable to type 'number'.",
          },
        ],
      },
    });

    expect(onPublishDiagnostics).toHaveBeenCalledTimes(1);
    expect(onPublishDiagnostics.mock.calls[0]?.[0]).toEqual({
      uri: "file:///tmp/workspace/src/example.ts",
      version: 2,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 9 },
          },
          severity: 1,
          code: "TS2322",
          source: "tsserver",
          message: "Type 'string' is not assignable to type 'number'.",
        },
      ],
      rawDiagnosticCount: 1,
    });
  });

  it("tags explicit clears so the manager can distinguish them from malformed publishes", () => {
    const onPublishDiagnostics = mock((_params: LspPublishDiagnosticsParams) => undefined);
    const { transport } = createClient({ onPublishDiagnostics });

    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/workspace/src/example.ts",
        diagnostics: [],
      },
    });

    expect(onPublishDiagnostics).toHaveBeenCalledTimes(1);
    expect(onPublishDiagnostics.mock.calls[0]?.[0]).toEqual({
      uri: "file:///tmp/workspace/src/example.ts",
      version: undefined,
      diagnostics: [],
      rawDiagnosticCount: 0,
    });
  });

  it("preserves malformed inner diagnostics so the manager can ignore them", () => {
    const onPublishDiagnostics = mock((_params: LspPublishDiagnosticsParams) => undefined);
    const { transport } = createClient({ onPublishDiagnostics });

    transport.onmessage?.({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: "file:///tmp/workspace/src/example.ts",
        diagnostics: [{ message: "missing range" }],
      },
    });

    expect(onPublishDiagnostics).toHaveBeenCalledTimes(1);
    expect(onPublishDiagnostics.mock.calls[0]?.[0]).toEqual({
      uri: "file:///tmp/workspace/src/example.ts",
      version: undefined,
      diagnostics: [],
      rawDiagnosticCount: 1,
    });
  });
});
