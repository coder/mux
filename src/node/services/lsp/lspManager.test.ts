import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WorkspaceLspDiagnosticsSnapshot } from "@/common/orpc/types";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { ExecOptions, ExecStream } from "@/node/runtime/Runtime";
import type {
  CreateLspClientOptions,
  LspClientInstance,
  LspClientQueryResult,
  LspDiagnostic,
  LspServerDescriptor,
} from "./types";
import { LspManager } from "./lspManager";

const TEST_LSP_POLICY_CONTEXT = {
  provisioningMode: "manual" as const,
  trustedWorkspaceExecution: true,
};

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function createRegistry(): readonly LspServerDescriptor[] {
  return [
    {
      id: "typescript",
      extensions: [".ts"],
      launch: {
        type: "manual",
        command: "mux-test-fake-lsp",
        args: ["--stdio"],
      },
      rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
      languageIdForPath: () => "typescript",
    },
  ];
}

function createManualDescriptor(
  id: string,
  extensions: readonly string[],
  command: string,
  rootMarkers: readonly string[]
): LspServerDescriptor {
  return {
    id,
    extensions,
    launch: {
      type: "manual",
      command,
      args: ["--stdio"],
    },
    rootMarkers,
    languageIdForPath: () => id,
  };
}

class CountingLocalRuntime extends LocalRuntime {
  readonly pathProbeCommands: string[] = [];

  override async exec(command: string, options: ExecOptions): Promise<ExecStream> {
    if (command.startsWith("command -v ")) {
      this.pathProbeCommands.push(command);
    }

    return await super.exec(command, options);
  }
}

function createDiagnostic(message: string): LspDiagnostic {
  return {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 5 },
    },
    severity: 1,
    source: "tsserver",
    message,
  };
}

function prependToPath(entry: string): string {
  return [entry, process.env.PATH]
    .filter((value): value is string => value != null && value.length > 0)
    .join(path.delimiter);
}

function requireDirectoryWorkspaceSymbolsResults(result: Awaited<ReturnType<LspManager["query"]>>) {
  expect(result.operation).toBe("workspace_symbols");
  if (!("results" in result)) {
    throw new Error("Expected a directory workspace_symbols result");
  }

  return result.results;
}

function requireSingleRootQueryResult(result: Awaited<ReturnType<LspManager["query"]>>) {
  if ("results" in result) {
    throw new Error("Expected a single-root LSP result");
  }

  return result;
}

const GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV = "EXPERIMENT_LSP_GO_EXACT_MATCH_SYMBOLS";

async function withGoExactMatchWorkspaceSymbolsEnv<T>(
  value: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  const previousValue = process.env[GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV];
  if (value == null) {
    delete process.env[GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV];
  } else {
    process.env[GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV] = value;
  }

  try {
    return await run();
  } finally {
    if (previousValue == null) {
      delete process.env[GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV];
    } else {
      process.env[GO_EXACT_MATCH_WORKSPACE_SYMBOLS_ENV] = previousValue;
    }
  }
}

describe("LspManager", () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-manager-"));
    await fs.mkdir(path.join(workspacePath, ".git"));
    await fs.mkdir(path.join(workspacePath, "src"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "packages", "pkg", "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "package.json"), "{}\n");
    await fs.writeFile(path.join(workspacePath, "src", "example.ts"), "export const value = 1;\n");
    await fs.writeFile(path.join(workspacePath, "packages", "pkg", "package.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      "export const nested = 1;\n"
    );
  });

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true });
  });

  async function queryGoWorkspaceSymbols(options: {
    filePath: string;
    envValue?: string;
  }): Promise<Awaited<ReturnType<LspManager["query"]>>> {
    const goFilePath = path.join(workspacePath, "main.go");
    await fs.writeFile(path.join(workspacePath, "go.mod"), "module example.com/mux-test\n");
    await fs.writeFile(
      goFilePath,
      "package main\n\nfunc useAttemptHelper() {}\nfunc useAttempt() {}\nfunc attemptUse() {}\n"
    );

    const goDescriptor = createManualDescriptor("go", [".go"], "mux-test-go-lsp", [
      "go.mod",
      ".git",
    ]);
    const clientFactory = mock(
      (clientOptions: CreateLspClientOptions): Promise<LspClientInstance> => {
        expect(clientOptions.descriptor.id).toBe("go");
        return Promise.resolve({
          isClosed: false,
          ensureFile: mock(() => Promise.resolve(1)),
          query: mock(() =>
            Promise.resolve({
              operation: "workspace_symbols" as const,
              symbols: [
                {
                  name: "useAttemptHelper",
                  kind: 12,
                  location: {
                    uri: pathToFileURL(goFilePath).href,
                    range: {
                      start: { line: 2, character: 5 },
                      end: { line: 2, character: 21 },
                    },
                  },
                },
                {
                  name: "useAttempt",
                  kind: 12,
                  location: {
                    uri: pathToFileURL(goFilePath).href,
                    range: {
                      start: { line: 3, character: 5 },
                      end: { line: 3, character: 15 },
                    },
                  },
                },
                {
                  name: "attemptUse",
                  kind: 12,
                  location: {
                    uri: pathToFileURL(goFilePath).href,
                    range: {
                      start: { line: 4, character: 5 },
                      end: { line: 4, character: 15 },
                    },
                  },
                },
              ],
            })
          ),
          close: mock(() => Promise.resolve(undefined)),
        });
      }
    );

    const manager = new LspManager({
      registry: [goDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      return await withGoExactMatchWorkspaceSymbolsEnv(
        options.envValue,
        async () =>
          await manager.query({
            workspaceId: "ws-go",
            runtime,
            workspacePath,
            filePath: options.filePath,
            policyContext: TEST_LSP_POLICY_CONTEXT,
            operation: "workspace_symbols",
            query: "useAttempt",
          })
      );
    } finally {
      await manager.dispose();
    }
  }

  function createWorkspaceSymbol(name: string, filePath: string, line: number, kind = 12) {
    return {
      name,
      kind,
      location: {
        uri: pathToFileURL(filePath).href,
        range: {
          start: { line, character: 0 },
          end: { line, character: name.length },
        },
      },
    };
  }

  async function queryMixedTypeScriptAndGoWorkspaceSymbols(options: {
    query: string;
    goSymbols: string[];
    envValue?: string;
  }): Promise<Awaited<ReturnType<LspManager["query"]>>> {
    const tsRootPath = path.join(workspacePath, "web", "packages", "teleport");
    const tsFilePath = path.join(tsRootPath, "src", `${options.query}.ts`);
    const goFilePath = path.join(workspacePath, "main.go");
    await fs.mkdir(path.dirname(tsFilePath), { recursive: true });
    await fs.writeFile(path.join(tsRootPath, "tsconfig.json"), "{}\n");
    await fs.writeFile(tsFilePath, `export const ${options.query} = 1;\n`);
    await fs.writeFile(path.join(workspacePath, "go.mod"), "module example.com/teleport\n");
    await fs.writeFile(
      goFilePath,
      `package main\n\n${options.goSymbols.map((name) => `func ${name}() {}`).join("\n")}\n`
    );

    const goDescriptor = createManualDescriptor("go", [".go"], "mux-test-go-lsp", [
      "go.mod",
      ".git",
    ]);
    const clientFactory = mock(
      (clientOptions: CreateLspClientOptions): Promise<LspClientInstance> => {
        return Promise.resolve({
          isClosed: false,
          ensureFile: mock(() => Promise.resolve(1)),
          query: mock(() => {
            if (clientOptions.descriptor.id === "go") {
              return Promise.resolve({
                operation: "workspace_symbols" as const,
                symbols: options.goSymbols.map((name, index) =>
                  createWorkspaceSymbol(name, goFilePath, index + 2)
                ),
              });
            }

            if (
              clientOptions.descriptor.id === "typescript" &&
              clientOptions.rootPath === tsRootPath
            ) {
              return Promise.resolve({
                operation: "workspace_symbols" as const,
                symbols: [createWorkspaceSymbol(options.query, tsFilePath, 0, 13)],
              });
            }

            return Promise.resolve({
              operation: "workspace_symbols" as const,
              symbols: [],
            });
          }),
          close: mock(() => Promise.resolve(undefined)),
        });
      }
    );

    const manager = new LspManager({
      registry: [...createRegistry(), goDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      return await withGoExactMatchWorkspaceSymbolsEnv(
        options.envValue,
        async () =>
          await manager.query({
            workspaceId: "ws-mixed-go-ts",
            runtime,
            workspacePath,
            filePath: ".",
            policyContext: TEST_LSP_POLICY_CONTEXT,
            operation: "workspace_symbols",
            query: options.query,
          })
      );
    } finally {
      await manager.dispose();
    }
  }

  async function queryTypeScriptFileBackedOperation(options: {
    operation: "references" | "document_symbols";
    buildRawResult(paths: { hookPath: string; usagePath: string }): LspClientQueryResult;
    line?: number;
    column?: number;
    includeDeclaration?: boolean;
  }): Promise<{
    result: Awaited<ReturnType<LspManager["query"]>>;
    clientFactoryOptions: CreateLspClientOptions;
    ensurePaths: string[];
    queryRequest: Parameters<LspClientInstance["query"]>[0];
    hookPath: string;
    usagePath: string;
  }> {
    const hookPath = path.join(
      workspacePath,
      "web",
      "packages",
      "shared",
      "hooks",
      "useAttempt.ts"
    );
    const usagePath = path.join(workspacePath, "web", "packages", "app", "src", "consumer.ts");
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.mkdir(path.dirname(usagePath), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify({ include: ["web/**/*.ts"] }, null, 2) + "\n"
    );
    await fs.writeFile(
      path.join(workspacePath, "web", "packages", "shared", "package.json"),
      "{}\n"
    );
    await fs.writeFile(path.join(workspacePath, "web", "packages", "app", "package.json"), "{}\n");
    await fs.writeFile(hookPath, "export function useAttempt() { return 1; }\n");
    await fs.writeFile(
      usagePath,
      'import { useAttempt } from "../../shared/hooks/useAttempt";\nexport const value = useAttempt();\n'
    );

    const ensurePaths: string[] = [];
    let clientFactoryOptions: CreateLspClientOptions | undefined;
    let queryRequest: Parameters<LspClientInstance["query"]>[0] | undefined;
    const clientFactory = mock(
      (resolvedOptions: CreateLspClientOptions): Promise<LspClientInstance> => {
        clientFactoryOptions = resolvedOptions;
        return Promise.resolve({
          isClosed: false,
          ensureFile: mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
            ensurePaths.push(file.readablePath);
            return Promise.resolve(1);
          }),
          query: mock((request: Parameters<LspClientInstance["query"]>[0]) => {
            queryRequest = request;
            return Promise.resolve(options.buildRawResult({ hookPath, usagePath }));
          }),
          close: mock(() => Promise.resolve(undefined)),
        });
      }
    );

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: `ws-${options.operation}`,
        runtime,
        workspacePath,
        filePath: "web/packages/shared/hooks/useAttempt.ts",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: options.operation,
        line: options.line,
        column: options.column,
        includeDeclaration: options.includeDeclaration,
      });

      if (!clientFactoryOptions) {
        throw new Error("Expected the LSP client factory to receive a call");
      }
      if (!queryRequest) {
        throw new Error("Expected the LSP client to receive a query");
      }

      return {
        result,
        clientFactoryOptions,
        ensurePaths,
        queryRequest,
        hookPath,
        usagePath,
      };
    } finally {
      await manager.dispose();
    }
  }

  test("prefers config-backed TypeScript roots for file-backed references queries", async () => {
    const { result, clientFactoryOptions, ensurePaths, queryRequest, usagePath, hookPath } =
      await queryTypeScriptFileBackedOperation({
        operation: "references",
        line: 1,
        column: 1,
        includeDeclaration: false,
        buildRawResult: ({ usagePath }) => ({
          operation: "references",
          locations: [
            {
              uri: pathToFileURL(usagePath).href,
              range: {
                start: { line: 1, character: 21 },
                end: { line: 1, character: 31 },
              },
            },
          ],
        }),
      });

    expect(clientFactoryOptions.rootPath).toBe(workspacePath);
    expect(ensurePaths).toEqual([hookPath]);
    expect(queryRequest).toMatchObject({
      operation: "references",
      line: 0,
      character: 0,
      includeDeclaration: false,
      file: {
        readablePath: hookPath,
      },
    });
    expect(requireSingleRootQueryResult(result)).toMatchObject({
      operation: "references",
      serverId: "typescript",
      rootUri: pathToFileURL(workspacePath).href,
      locations: [
        {
          path: usagePath,
          uri: pathToFileURL(usagePath).href,
        },
      ],
    });
  });

  test("prefers config-backed TypeScript roots for file-backed document_symbols queries", async () => {
    const { result, clientFactoryOptions, ensurePaths, queryRequest, hookPath } =
      await queryTypeScriptFileBackedOperation({
        operation: "document_symbols",
        buildRawResult: ({ hookPath }) => ({
          operation: "document_symbols",
          symbols: [
            {
              name: "useAttempt",
              kind: 12,
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 40 },
              },
              selectionRange: {
                start: { line: 0, character: 16 },
                end: { line: 0, character: 26 },
              },
              uri: pathToFileURL(hookPath).href,
            },
          ],
        }),
      });

    expect(clientFactoryOptions.rootPath).toBe(workspacePath);
    expect(ensurePaths).toEqual([hookPath]);
    expect(queryRequest).toMatchObject({
      operation: "document_symbols",
      file: {
        readablePath: hookPath,
      },
    });
    expect(queryRequest.line).toBeUndefined();
    expect(queryRequest.character).toBeUndefined();
    expect(requireSingleRootQueryResult(result)).toMatchObject({
      operation: "document_symbols",
      serverId: "typescript",
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [
        {
          name: "useAttempt",
          path: hookPath,
          uri: pathToFileURL(hookPath).href,
        },
      ],
    });
  });

  test("reuses clients for the same workspace root and forwards normalized positions", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    let lastQueryRequest: Parameters<LspClientInstance["query"]>[0] | undefined;
    const query = mock((request: Parameters<LspClientInstance["query"]>[0]) => {
      lastQueryRequest = request;
      return Promise.resolve({
        operation: "hover" as const,
        hover: "const value: 1",
      });
    });
    const close = mock(() => Promise.resolve(undefined));
    const client: LspClientInstance = {
      isClosed: false,
      ensureFile,
      query,
      close,
    };
    let clientFactoryOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryOptions = options;
      return Promise.resolve(client);
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const firstResult = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 2,
      column: 3,
    });
    const secondResult = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 2,
      column: 3,
    });

    expect(requireSingleRootQueryResult(firstResult).hover).toBe("const value: 1");
    expect(requireSingleRootQueryResult(secondResult).hover).toBe("const value: 1");
    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(ensureFile).toHaveBeenCalledTimes(2);
    expect(clientFactoryOptions).toBeDefined();
    if (!clientFactoryOptions) {
      throw new Error("Expected the LSP client factory to receive a call");
    }
    expect(clientFactoryOptions.rootPath).toBe(workspacePath);
    expect(clientFactoryOptions.launchPlan).toEqual({
      command: "mux-test-fake-lsp",
      args: ["--stdio"],
      cwd: workspacePath,
      env: undefined,
      initializationOptions: undefined,
    });

    expect(lastQueryRequest).toBeDefined();
    if (!lastQueryRequest) {
      throw new Error("Expected the LSP client to receive a query");
    }
    expect(lastQueryRequest.line).toBe(1);
    expect(lastQueryRequest.character).toBe(2);

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("prefers config-backed TypeScript roots and warms explicit workspace_symbols file queries", async () => {
    const resourcePath = path.join(
      workspacePath,
      "web",
      "packages",
      "teleport",
      "src",
      "services",
      "resources",
      "resource.ts"
    );
    await fs.mkdir(path.dirname(resourcePath), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify({ include: ["web/**/*.ts"] }, null, 2) + "\n"
    );
    await fs.writeFile(
      path.join(workspacePath, "web", "packages", "teleport", "package.json"),
      "{}\n"
    );
    await fs.writeFile(resourcePath, "export class ResourceService {}\n");

    const ensureEvents: string[] = [];
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      ensureEvents.push(`ensure:${file.readablePath}`);
      return Promise.resolve(1);
    });
    const queryEvents: string[] = [];
    let clientFactoryOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock((request: Parameters<LspClientInstance["query"]>[0]) => {
          queryEvents.push(`query:${request.file?.readablePath ?? "directory"}`);
          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourceService",
                kind: 5,
                location: {
                  uri: pathToFileURL(resourcePath).href,
                  range: {
                    start: { line: 0, character: 13 },
                    end: { line: 0, character: 28 },
                  },
                },
              },
            ],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: "web/packages/teleport/src/services/resources/resource.ts",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        serverId: "typescript",
        rootUri: pathToFileURL(workspacePath).href,
        symbols: [
          {
            name: "ResourceService",
            kindLabel: "Class",
            path: resourcePath,
            uri: pathToFileURL(resourcePath).href,
            exportInfo: {
              isExported: true,
              confidence: "heuristic",
              evidence: "Found an export keyword near the declaration",
            },
          },
        ],
      });
      expect(clientFactoryOptions).toBeDefined();
      if (!clientFactoryOptions) {
        throw new Error("Expected the LSP client factory to receive a call");
      }
      expect(clientFactoryOptions.rootPath).toBe(workspacePath);
      expect(ensureEvents).toEqual([`ensure:${resourcePath}`]);
      expect(queryEvents).toEqual([`query:${resourcePath}`]);
      expect(ensureFile).toHaveBeenCalledTimes(1);
      expect(clientFactory).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  test("warms a representative TypeScript file before directory workspace_symbols queries", async () => {
    const ensureFileCalls: Array<Parameters<LspClientInstance["ensureFile"]>[0]> = [];
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      ensureFileCalls.push(file);
      return Promise.resolve(1);
    });
    const queryRequests: Array<Parameters<LspClientInstance["query"]>[0]> = [];
    const clientFactoryOptions: CreateLspClientOptions[] = [];
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryOptions.push(options);
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock((request: Parameters<LspClientInstance["query"]>[0]) => {
          queryRequests.push(request);
          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [],
          });
        }),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const result = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "./",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "workspace_symbols",
      query: "ResourceService",
    });

    expect(result).toEqual({
      operation: "workspace_symbols",
      results: [],
    });
    expect(clientFactoryOptions.map((options) => options.rootPath)).toEqual([workspacePath]);
    expect(ensureFileCalls).toEqual([
      {
        runtimePath: path.join(workspacePath, "src", "example.ts"),
        readablePath: path.join(workspacePath, "src", "example.ts"),
        uri: pathToFileURL(path.join(workspacePath, "src", "example.ts")).href,
        languageId: "typescript",
      },
    ]);
    expect(queryRequests).toHaveLength(1);
    for (const request of queryRequests) {
      expect(request).toMatchObject({
        operation: "workspace_symbols",
        query: "ResourceService",
      });
      expect(request.file).toBeUndefined();
    }

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("prefers repo-root TypeScript files over nested child TS projects during warm-up", async () => {
    await fs.rm(path.join(workspacePath, "src"), { recursive: true, force: true });
    await fs.rm(path.join(workspacePath, "packages"), { recursive: true, force: true });

    const rootResourcePath = path.join(
      workspacePath,
      "web",
      "packages",
      "teleport",
      "src",
      "services",
      "resources",
      "resource.ts"
    );
    const designComponentPath = path.join(
      workspacePath,
      "web",
      "packages",
      "design",
      "src",
      "button.ts"
    );
    const e2eSpecPath = path.join(workspacePath, "e2e", "tests", "resource.spec.ts");
    await fs.mkdir(path.dirname(rootResourcePath), { recursive: true });
    await fs.mkdir(path.dirname(designComponentPath), { recursive: true });
    await fs.mkdir(path.dirname(e2eSpecPath), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify({ include: ["web/**/*.ts"] }, null, 2) + "\n"
    );
    await fs.writeFile(path.join(workspacePath, "go.mod"), "module example.com/teleport\n");
    await fs.writeFile(
      path.join(workspacePath, "web", "packages", "design", "tsconfig.json"),
      "{}\n"
    );
    await fs.writeFile(path.join(workspacePath, "e2e", "tsconfig.json"), "{}\n");
    await fs.writeFile(rootResourcePath, "export class ResourceService {}\n");
    await fs.writeFile(designComponentPath, "export const Button = 1;\n");
    await fs.writeFile(e2eSpecPath, "export const resourceSpec = 1;\n");

    const goDescriptor = createManualDescriptor("go", [".go"], "mux-test-go-lsp", [
      "go.mod",
      ".git",
    ]);
    const warmupPathsByRoot = new Map<string, string[]>();
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
          const warmedPaths = warmupPathsByRoot.get(options.rootPath) ?? [];
          warmedPaths.push(file.readablePath);
          warmupPathsByRoot.set(options.rootPath, warmedPaths);
          return Promise.resolve(1);
        }),
        query: mock(() => {
          if (
            options.descriptor.id === "typescript" &&
            options.rootPath === workspacePath &&
            warmupPathsByRoot.get(options.rootPath)?.at(-1) === rootResourcePath
          ) {
            return Promise.resolve({
              operation: "workspace_symbols" as const,
              symbols: [
                {
                  name: "ResourceService",
                  kind: 5,
                  location: {
                    uri: pathToFileURL(rootResourcePath).href,
                    range: {
                      start: { line: 0, character: 13 },
                      end: { line: 0, character: 28 },
                    },
                  },
                },
              ],
            });
          }

          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), goDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [
          {
            serverId: "typescript",
            rootUri: pathToFileURL(workspacePath).href,
            symbols: [
              {
                name: "ResourceService",
                path: rootResourcePath,
              },
            ],
          },
        ],
      });
      expect(warmupPathsByRoot).toEqual(
        new Map([
          [workspacePath, [rootResourcePath]],
          [path.join(workspacePath, "e2e"), [e2eSpecPath]],
          [path.join(workspacePath, "web", "packages", "design"), [designComponentPath]],
        ])
      );
    } finally {
      await manager.dispose();
    }
  });

  test("prefers repo-root TypeScript files whose contents exactly match the queried symbol", async () => {
    await fs.rm(path.join(workspacePath, "src"), { recursive: true, force: true });

    const rootResourcePath = path.join(
      workspacePath,
      "web",
      "packages",
      "teleport",
      "src",
      "services",
      "resources",
      "resource.ts"
    );
    const misleadingPluralPath = path.join(
      workspacePath,
      "web",
      "packages",
      "teleterm",
      "src",
      "services",
      "resources",
      "resources-service.test.ts"
    );
    await fs.mkdir(path.dirname(rootResourcePath), { recursive: true });
    await fs.mkdir(path.dirname(misleadingPluralPath), { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, "tsconfig.json"),
      JSON.stringify({ include: ["web/**/*.ts"] }, null, 2) + "\n"
    );
    await fs.writeFile(rootResourcePath, "export class ResourceService {}\n");
    await fs.writeFile(misleadingPluralPath, "export class ResourcesService {}\n");

    const warmupPathsByRoot = new Map<string, string[]>();
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
          const warmedPaths = warmupPathsByRoot.get(options.rootPath) ?? [];
          warmedPaths.push(file.readablePath);
          warmupPathsByRoot.set(options.rootPath, warmedPaths);
          return Promise.resolve(1);
        }),
        query: mock(() => {
          const warmedPath = warmupPathsByRoot.get(options.rootPath)?.at(-1);
          if (warmedPath === rootResourcePath) {
            return Promise.resolve({
              operation: "workspace_symbols" as const,
              symbols: [
                {
                  name: "ResourceService",
                  kind: 5,
                  location: {
                    uri: pathToFileURL(rootResourcePath).href,
                    range: {
                      start: { line: 0, character: 13 },
                      end: { line: 0, character: 28 },
                    },
                  },
                },
              ],
            });
          }

          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourcesService",
                kind: 5,
                location: {
                  uri: pathToFileURL(misleadingPluralPath).href,
                  range: {
                    start: { line: 0, character: 13 },
                    end: { line: 0, character: 29 },
                  },
                },
              },
            ],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [
          {
            serverId: "typescript",
            rootUri: pathToFileURL(workspacePath).href,
            symbols: [
              {
                name: "ResourceService",
                path: rootResourcePath,
              },
            ],
          },
        ],
      });
      expect(warmupPathsByRoot).toEqual(new Map([[workspacePath, [rootResourcePath]]]));
    } finally {
      await manager.dispose();
    }
  });

  test("filters Go workspace_symbols to exact matches by default for single-root queries", async () => {
    const result = await queryGoWorkspaceSymbols({
      filePath: "main.go",
    });

    expect(requireSingleRootQueryResult(result)).toMatchObject({
      operation: "workspace_symbols",
      serverId: "go",
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [
        {
          name: "useAttempt",
          path: path.join(workspacePath, "main.go"),
        },
      ],
    });
  });

  test("filters Go workspace_symbols for directory queries unless the env var disables it", async () => {
    const defaultResults = requireDirectoryWorkspaceSymbolsResults(
      await queryGoWorkspaceSymbols({
        filePath: ".",
      })
    );
    expect(defaultResults).toHaveLength(1);
    expect(defaultResults[0]).toMatchObject({
      serverId: "go",
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [
        {
          name: "useAttempt",
        },
      ],
    });

    const disabledResults = requireDirectoryWorkspaceSymbolsResults(
      await queryGoWorkspaceSymbols({
        filePath: ".",
        envValue: "false",
      })
    );
    expect(disabledResults).toHaveLength(1);
    expect(disabledResults[0]).toMatchObject({
      serverId: "go",
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [{ name: "useAttemptHelper" }, { name: "useAttempt" }, { name: "attemptUse" }],
    });
  });

  test("suppresses fuzzy Go workspace_symbols groups when another root has an exact match", async () => {
    const defaultResults = requireDirectoryWorkspaceSymbolsResults(
      await queryMixedTypeScriptAndGoWorkspaceSymbols({
        query: "useAttempt",
        goSymbols: ["useAttemptHelper", "attemptUse"],
      })
    );
    expect(defaultResults).toHaveLength(1);
    expect(defaultResults[0]).toMatchObject({
      serverId: "typescript",
      rootUri: pathToFileURL(path.join(workspacePath, "web", "packages", "teleport")).href,
      symbols: [
        {
          name: "useAttempt",
          path: path.join(workspacePath, "web", "packages", "teleport", "src", "useAttempt.ts"),
        },
      ],
    });

    const disabledResults = requireDirectoryWorkspaceSymbolsResults(
      await queryMixedTypeScriptAndGoWorkspaceSymbols({
        query: "useAttempt",
        goSymbols: ["useAttemptHelper", "attemptUse"],
        envValue: "false",
      })
    );
    expect(disabledResults).toHaveLength(2);
    const disabledGoResult = disabledResults.find((result) => result.serverId === "go");
    if (!disabledGoResult) {
      throw new Error("Expected Go workspace_symbols results when the experiment is disabled");
    }
    expect(disabledGoResult).toMatchObject({
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [{ name: "useAttemptHelper" }, { name: "attemptUse" }],
    });
    const disabledTypeScriptResult = disabledResults.find(
      (result) => result.serverId === "typescript"
    );
    if (!disabledTypeScriptResult) {
      throw new Error("Expected TypeScript workspace_symbols results for the nested root");
    }
    expect(disabledTypeScriptResult).toMatchObject({
      rootUri: pathToFileURL(path.join(workspacePath, "web", "packages", "teleport")).href,
      symbols: [{ name: "useAttempt" }],
    });
  });

  test("keeps exact Go workspace_symbols groups when Go also has an exact match", async () => {
    const results = requireDirectoryWorkspaceSymbolsResults(
      await queryMixedTypeScriptAndGoWorkspaceSymbols({
        query: "ResourceService",
        goSymbols: ["ResourceService", "ResourceServiceHelper"],
      })
    );

    expect(results).toHaveLength(2);
    const goResult = results.find((result) => result.serverId === "go");
    if (!goResult) {
      throw new Error("Expected Go workspace_symbols results when Go has an exact match");
    }
    expect(goResult).toMatchObject({
      rootUri: pathToFileURL(workspacePath).href,
      symbols: [{ name: "ResourceService" }],
    });
    const typeScriptResult = results.find((result) => result.serverId === "typescript");
    if (!typeScriptResult) {
      throw new Error("Expected TypeScript workspace_symbols results for the nested root");
    }
    expect(typeScriptResult).toMatchObject({
      rootUri: pathToFileURL(path.join(workspacePath, "web", "packages", "teleport")).href,
      symbols: [
        {
          name: "ResourceService",
          path: path.join(
            workspacePath,
            "web",
            "packages",
            "teleport",
            "src",
            "ResourceService.ts"
          ),
        },
      ],
    });
  });

  test("prefers the deepest matching workspace_symbols root for nested directories", async () => {
    const pythonWorkspacePath = path.join(workspacePath, "services", "python");
    await fs.mkdir(pythonWorkspacePath, { recursive: true });
    await fs.writeFile(
      path.join(pythonWorkspacePath, "pyproject.toml"),
      "[project]\nname = 'python-service'\n"
    );

    const pythonDescriptor: LspServerDescriptor = {
      id: "python",
      extensions: [".py"],
      launch: {
        type: "manual",
        command: "mux-test-python-lsp",
        args: ["--stdio"],
      },
      rootMarkers: ["pyproject.toml", ".git"],
      languageIdForPath: () => "python",
    };
    let clientFactoryOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [],
          })
        ),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: "services/python",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [],
      });
      expect(clientFactory).toHaveBeenCalledTimes(1);
      expect(clientFactoryOptions).toBeDefined();
      if (!clientFactoryOptions) {
        throw new Error("Expected the LSP client factory to receive a call");
      }
      expect(clientFactoryOptions.rootPath).toBe(pythonWorkspacePath);
    } finally {
      await manager.dispose();
    }
  });

  test("returns repo-root TypeScript symbols in mixed-language monorepos", async () => {
    await fs.writeFile(path.join(workspacePath, "go.mod"), "module example.com/mux\n");
    await fs.writeFile(path.join(workspacePath, "Cargo.toml"), "[package]\nname = 'mux'\n");
    await fs.writeFile(path.join(workspacePath, "packages", "pkg", "tsconfig.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      "export class ResourceService {}\n"
    );
    await fs.mkdir(path.join(workspacePath, "services", "api"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "crates", "core", "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "services", "api", "main.go"), "package api\n");
    await fs.writeFile(
      path.join(workspacePath, "crates", "core", "src", "lib.rs"),
      "pub fn core() {}\n"
    );

    const goDescriptor = createManualDescriptor("go", [".go"], "mux-test-go-lsp", [
      "go.mod",
      ".git",
    ]);
    const rustDescriptor = createManualDescriptor("rust", [".rs"], "mux-test-rust-lsp", [
      "Cargo.toml",
      ".git",
    ]);
    const queryOrder: string[] = [];
    const warmupPathsByRoot = new Map<string, string[]>();
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
          const warmedPaths = warmupPathsByRoot.get(options.rootPath) ?? [];
          warmedPaths.push(file.readablePath);
          warmupPathsByRoot.set(options.rootPath, warmedPaths);
          return Promise.resolve(1);
        }),
        query: mock(() => {
          queryOrder.push(`${options.descriptor.id}:${options.rootPath}`);
          if (options.rootPath === path.join(workspacePath, "packages", "pkg")) {
            return Promise.resolve({
              operation: "workspace_symbols" as const,
              symbols: [
                {
                  name: "ResourceService",
                  kind: 5,
                  location: {
                    uri: pathToFileURL(
                      path.join(workspacePath, "packages", "pkg", "src", "nested.ts")
                    ).href,
                    range: {
                      start: { line: 0, character: 13 },
                      end: { line: 0, character: 28 },
                    },
                  },
                },
              ],
            });
          }

          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), goDescriptor, rustDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [
          {
            serverId: "typescript",
            rootUri: pathToFileURL(path.join(workspacePath, "packages", "pkg")).href,
            symbols: [
              {
                name: "ResourceService",
                path: path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
              },
            ],
          },
        ],
      });
      expect(warmupPathsByRoot).toEqual(
        new Map([
          [workspacePath, [path.join(workspacePath, "src", "example.ts")]],
          [
            path.join(workspacePath, "packages", "pkg"),
            [path.join(workspacePath, "packages", "pkg", "src", "nested.ts")],
          ],
        ])
      );
      expect(queryOrder).toEqual([
        `typescript:${workspacePath}`,
        `go:${workspacePath}`,
        `rust:${workspacePath}`,
        `typescript:${path.join(workspacePath, "packages", "pkg")}`,
      ]);
      expect(clientFactory).toHaveBeenCalledTimes(4);
    } finally {
      await manager.dispose();
    }
  });

  test("ignores package-only TypeScript descendants during workspace_symbols root discovery", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");
    await fs.mkdir(path.join(workspacePath, "packages", "other", "src"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "packages", "project", "src"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "packages", "other", "package.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "packages", "other", "src", "other.ts"),
      "export const other = 1;\n"
    );
    await fs.writeFile(path.join(workspacePath, "packages", "project", "package.json"), "{}\n");
    await fs.writeFile(path.join(workspacePath, "packages", "project", "tsconfig.json"), "{}\n");
    await fs.writeFile(
      path.join(workspacePath, "packages", "project", "src", "project.ts"),
      "export class ProjectResource {}\n"
    );
    await fs.writeFile(
      path.join(workspacePath, "resource.py"),
      "class ResourceService:\n    pass\n"
    );

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const queryOrder: string[] = [];
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() => {
          queryOrder.push(`${options.descriptor.id}:${options.rootPath}`);
          if (options.descriptor.id === "typescript") {
            throw new Error("No Project");
          }

          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourceService",
                kind: 5,
                containerName: "resource",
                location: {
                  uri: pathToFileURL(path.join(workspacePath, "resource.py")).href,
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 21 },
                  },
                },
              },
            ],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [
          {
            serverId: "python",
            rootUri: pathToFileURL(workspacePath).href,
            symbols: [
              {
                name: "ResourceService",
                path: path.join(workspacePath, "resource.py"),
                containerName: "resource",
              },
            ],
          },
        ],
      });
      expect(queryOrder).toEqual([
        `typescript:${workspacePath}`,
        `python:${workspacePath}`,
        `typescript:${path.join(workspacePath, "packages", "project")}`,
      ]);
      expect(result.warning).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  test("summarizes workspace_symbols warnings when many descendant roots fail", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");
    for (const projectName of ["proj-a", "proj-b", "proj-c", "proj-d"]) {
      await fs.mkdir(path.join(workspacePath, "packages", projectName, "src"), { recursive: true });
      await fs.writeFile(path.join(workspacePath, "packages", projectName, "package.json"), "{}\n");
      await fs.writeFile(
        path.join(workspacePath, "packages", projectName, "tsconfig.json"),
        "{}\n"
      );
      await fs.writeFile(
        path.join(workspacePath, "packages", projectName, "src", `${projectName}.ts`),
        `export const ${projectName.replace(/-/g, "_")} = 1;\n`
      );
    }
    await fs.writeFile(
      path.join(workspacePath, "resource.py"),
      "class ResourceService:\n    pass\n"
    );

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() => {
          if (options.descriptor.id === "typescript") {
            throw new Error("No Project");
          }

          return Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourceService",
                kind: 5,
                location: {
                  uri: pathToFileURL(path.join(workspacePath, "resource.py")).href,
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 21 },
                  },
                },
              },
            ],
          });
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result.warning).toBeUndefined();
      const workspaceSymbolsResults = requireDirectoryWorkspaceSymbolsResults(result);
      expect(workspaceSymbolsResults).toHaveLength(1);
      expect(workspaceSymbolsResults[0]).toMatchObject({
        serverId: "python",
        rootUri: pathToFileURL(workspacePath).href,
      });
      expect(workspaceSymbolsResults[0]?.symbols).toHaveLength(1);
      expect(workspaceSymbolsResults[0]?.symbols[0]).toMatchObject({
        name: "ResourceService",
        path: path.join(workspacePath, "resource.py"),
      });
      if (!("results" in result)) {
        throw new Error("Expected directory workspace_symbols metadata");
      }
      expect(result.skippedRoots).toHaveLength(5);
      expect(result.skippedRoots?.every((root) => root.reasonCode === "query_failed")).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  test("surfaces structured skippedRoots guidance alongside partial workspace_symbols success", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");
    await fs.writeFile(path.join(workspacePath, "Cargo.toml"), "[package]\nname = 'mux'\n");
    await fs.writeFile(
      path.join(workspacePath, "resource.py"),
      "class ResourceService:\n    pass\n"
    );

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const rustDescriptor: LspServerDescriptor = {
      id: "rust",
      extensions: [".rs"],
      launch: {
        type: "provisioned",
        strategies: [
          {
            type: "unsupported",
            message:
              "rust-analyzer is not available on PATH and automatic installation is not supported yet",
          },
        ],
      },
      rootMarkers: ["Cargo.toml", ".git"],
      languageIdForPath: () => "rust",
    };
    const resourcePath = path.join(workspacePath, "resource.py");
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      if (options.descriptor.id !== "python") {
        throw new Error("Expected unsupported rust provisioning to fail before client creation");
      }

      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourceService",
                kind: 5,
                location: {
                  uri: pathToFileURL(resourcePath).href,
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 21 },
                  },
                },
              },
            ],
          })
        ),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [pythonDescriptor, rustDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: {
          provisioningMode: "auto",
          trustedWorkspaceExecution: true,
        },
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toMatchObject({
        operation: "workspace_symbols",
        results: [
          {
            serverId: "python",
            rootUri: pathToFileURL(workspacePath).href,
            symbols: [{ name: "ResourceService", path: resourcePath }],
          },
        ],
        skippedRoots: [
          {
            serverId: "rust",
            rootUri: pathToFileURL(workspacePath).href,
            reasonCode: "unsupported_provisioning",
            installGuidance:
              "Install rust-analyzer and ensure it is available on PATH, or query a representative source file for a supported language.",
          },
        ],
      });
      expect(clientFactory).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  test("adds a disambiguation hint when multiple roots return workspace symbol matches", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");
    await fs.writeFile(
      path.join(workspacePath, "src", "resource.ts"),
      "export class ResourceService {}\n"
    );
    await fs.writeFile(
      path.join(workspacePath, "resource.py"),
      "class ResourceService:\n    pass\n"
    );

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const typescriptResourcePath = path.join(workspacePath, "src", "resource.ts");
    const pythonResourcePath = path.join(workspacePath, "resource.py");
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [
              {
                name: "ResourceService",
                kind: 5,
                location: {
                  uri:
                    options.descriptor.id === "typescript"
                      ? pathToFileURL(typescriptResourcePath).href
                      : pathToFileURL(pythonResourcePath).href,
                  range: {
                    start: { line: 0, character: 6 },
                    end: { line: 0, character: 21 },
                  },
                },
              },
            ],
          })
        ),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      if (!("results" in result)) {
        throw new Error("Expected a directory workspace_symbols result");
      }
      expect(result.results).toHaveLength(2);
      expect(result.disambiguationHint).toContain("ResourceService");
      expect(result.disambiguationHint).toContain("kindLabel");
    } finally {
      await manager.dispose();
    }
  });

  test("returns an empty workspace_symbols result when every queried root succeeds without symbols", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({
            operation: "workspace_symbols" as const,
            symbols: [],
          })
        ),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      const result = await manager.query({
        workspaceId: "ws-1",
        runtime,
        workspacePath,
        filePath: ".",
        policyContext: TEST_LSP_POLICY_CONTEXT,
        operation: "workspace_symbols",
        query: "ResourceService",
      });

      expect(result).toEqual({
        operation: "workspace_symbols",
        results: [],
      });
      expect(clientFactory).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  test("fails workspace_symbols directory inference when every queried root errors", async () => {
    await fs.writeFile(path.join(workspacePath, "pyproject.toml"), "[project]\nname = 'mixed'\n");

    const pythonDescriptor = createManualDescriptor("python", [".py"], "mux-test-python-lsp", [
      "pyproject.toml",
      ".git",
    ]);
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() => {
          if (options.descriptor.id === "typescript") {
            throw new Error("tsserver unavailable");
          }

          throw new Error("No Project");
        }),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: [...createRegistry(), pythonDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(
        manager.query({
          workspaceId: "ws-1",
          runtime,
          workspacePath,
          filePath: ".",
          policyContext: TEST_LSP_POLICY_CONTEXT,
          operation: "workspace_symbols",
          query: "ResourceService",
        })
      ).rejects.toThrow(
        "No usable LSP roots are available for directory .; typescript (package.json) at .: tsserver unavailable; python (pyproject.toml) at .: No Project. Install the missing language server or query a representative source file for a supported language."
      );
      expect(clientFactory).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  test("surfaces unsupported PATH-only directory roots when no usable LSP roots remain", async () => {
    await fs.writeFile(path.join(workspacePath, "Cargo.toml"), "[package]\nname = 'mux'\n");

    const rustDescriptor: LspServerDescriptor = {
      id: "rust",
      extensions: [".rs"],
      launch: {
        type: "provisioned",
        strategies: [
          {
            type: "unsupported",
            message:
              "rust-analyzer is not available on PATH and automatic installation is not supported yet",
          },
        ],
      },
      rootMarkers: ["Cargo.toml", ".git"],
      languageIdForPath: () => "rust",
    };
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      throw new Error("Expected unsupported provisioning to fail before client creation");
    });

    const manager = new LspManager({
      registry: [rustDescriptor],
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(
        manager.query({
          workspaceId: "ws-1",
          runtime,
          workspacePath,
          filePath: ".",
          policyContext: {
            provisioningMode: "auto",
            trustedWorkspaceExecution: true,
          },
          operation: "workspace_symbols",
          query: "ResourceService",
        })
      ).rejects.toThrow(
        "rust-analyzer is not available on PATH and automatic installation is not supported yet"
      );
      // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun's expect().rejects.toThrow() is thenable at runtime
      await expect(
        manager.query({
          workspaceId: "ws-1",
          runtime,
          workspacePath,
          filePath: ".",
          policyContext: {
            provisioningMode: "auto",
            trustedWorkspaceExecution: true,
          },
          operation: "workspace_symbols",
          query: "ResourceService",
        })
      ).rejects.toThrow("Install rust-analyzer and ensure it is available on PATH");
      expect(clientFactory).toHaveBeenCalledTimes(0);
    } finally {
      await manager.dispose();
    }
  });

  test("reuses launch-plan probes for warm clients but re-runs them for a different root", async () => {
    const lspBinDir = path.join(workspacePath, "tools", "bin");
    const lspExecutable = path.join(lspBinDir, "fake-lsp");
    const launchPath = prependToPath(lspBinDir);
    await fs.mkdir(lspBinDir, { recursive: true });
    await fs.writeFile(lspExecutable, "#!/bin/sh\nexit 0\n");
    await fs.chmod(lspExecutable, 0o755);

    const baseDescriptor = createRegistry()[0];
    if (!baseDescriptor) {
      throw new Error("Expected the test registry to provide a descriptor");
    }

    const descriptor: LspServerDescriptor = {
      ...baseDescriptor,
      launch: {
        type: "manual",
        command: "fake-lsp",
        args: ["--stdio"],
        env: { PATH: launchPath },
      },
    };
    const launchPlans: Array<CreateLspClientOptions["launchPlan"]> = [];
    const closeMocks: Array<ReturnType<typeof mock>> = [];
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      launchPlans.push(options.launchPlan);
      const close = mock(() => Promise.resolve(undefined));
      closeMocks.push(close);
      return Promise.resolve({
        isClosed: false,
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({ operation: "hover" as const, hover: options.rootPath })
        ),
        close,
      });
    });

    const manager = new LspManager({
      registry: [descriptor],
      clientFactory,
    });
    const runtime = new CountingLocalRuntime(workspacePath);

    const first = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    const second = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    const third = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "packages/pkg/src/nested.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    expect(requireSingleRootQueryResult(first).hover).toBe(workspacePath);
    expect(requireSingleRootQueryResult(second).hover).toBe(workspacePath);
    expect(requireSingleRootQueryResult(third).hover).toBe(
      path.join(workspacePath, "packages", "pkg")
    );
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(runtime.pathProbeCommands).toHaveLength(2);
    expect(launchPlans).toEqual([
      {
        command: lspExecutable,
        args: ["--stdio"],
        cwd: workspacePath,
        env: { PATH: launchPath },
        initializationOptions: undefined,
      },
      {
        command: lspExecutable,
        args: ["--stdio"],
        cwd: path.join(workspacePath, "packages", "pkg"),
        env: { PATH: launchPath },
        initializationOptions: undefined,
      },
    ]);

    await manager.dispose();
    expect(closeMocks).toHaveLength(2);
    for (const close of closeMocks) {
      expect(close).toHaveBeenCalledTimes(1);
    }
  });

  test("creates separate clients when LSP policy context changes for the same root", async () => {
    const externalBinDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-lsp-global-bin-"));
    try {
      const localExecutable = path.join(
        workspacePath,
        "node_modules",
        ".bin",
        "typescript-language-server"
      );
      const workspacePathExecutable = path.join(
        workspacePath,
        "tools",
        "bin",
        "typescript-language-server"
      );
      const externalPathExecutable = path.join(externalBinDir, "typescript-language-server");
      await fs.mkdir(path.dirname(localExecutable), { recursive: true });
      await fs.mkdir(path.dirname(workspacePathExecutable), { recursive: true });
      await fs.writeFile(localExecutable, "#!/bin/sh\nexit 0\n");
      await fs.writeFile(workspacePathExecutable, "#!/bin/sh\nexit 0\n");
      await fs.writeFile(externalPathExecutable, "#!/bin/sh\nexit 0\n");
      await fs.chmod(localExecutable, 0o755);
      await fs.chmod(workspacePathExecutable, 0o755);
      await fs.chmod(externalPathExecutable, 0o755);

      const descriptor: LspServerDescriptor = {
        id: "typescript",
        extensions: [".ts"],
        launch: {
          type: "provisioned",
          args: ["--stdio"],
          env: {
            PATH: [path.join(workspacePath, "tools", "bin"), prependToPath(externalBinDir)]
              .filter((value) => value.length > 0)
              .join(path.delimiter),
          },
          strategies: [
            {
              type: "workspaceLocalExecutable",
              relativeCandidates: ["node_modules/.bin/typescript-language-server"],
            },
            { type: "pathCommand", command: "typescript-language-server" },
          ],
        },
        rootMarkers: ["package.json", ".git"],
        languageIdForPath: () => "typescript",
      };

      const launchPlans: Array<CreateLspClientOptions["launchPlan"]> = [];
      const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
        launchPlans.push(options.launchPlan);
        return Promise.resolve({
          isClosed: false,
          ensureFile: mock(() => Promise.resolve(1)),
          query: mock(() =>
            Promise.resolve({ operation: "hover" as const, hover: options.launchPlan.command })
          ),
          close: mock(() => Promise.resolve(undefined)),
        });
      });

      const manager = new LspManager({ registry: [descriptor], clientFactory });
      const runtime = new CountingLocalRuntime(workspacePath);
      try {
        const trustedResult = await manager.query({
          workspaceId: "ws-1",
          runtime,
          workspacePath,
          filePath: "src/example.ts",
          policyContext: TEST_LSP_POLICY_CONTEXT,
          operation: "hover",
          line: 1,
          column: 1,
        });
        const untrustedResult = await manager.query({
          workspaceId: "ws-1",
          runtime,
          workspacePath,
          filePath: "src/example.ts",
          policyContext: {
            provisioningMode: "manual",
            trustedWorkspaceExecution: false,
          },
          operation: "hover",
          line: 1,
          column: 1,
        });

        expect(requireSingleRootQueryResult(trustedResult).hover).toBe(localExecutable);
        expect(requireSingleRootQueryResult(untrustedResult).hover).toBe(externalPathExecutable);
        expect(clientFactory).toHaveBeenCalledTimes(2);
        expect(launchPlans.map((plan) => plan.command)).toEqual([
          localExecutable,
          externalPathExecutable,
        ]);
      } finally {
        await manager.dispose();
      }
    } finally {
      await fs.rm(externalBinDir, { recursive: true, force: true });
    }
  });

  test("re-probes launch plans after a closed client is recreated", async () => {
    const firstBinDir = path.join(workspacePath, "tools", "first-bin");
    const secondBinDir = path.join(workspacePath, "tools", "second-bin");
    const firstExecutable = path.join(firstBinDir, "fake-lsp");
    const secondExecutable = path.join(secondBinDir, "fake-lsp");
    await fs.mkdir(firstBinDir, { recursive: true });
    await fs.mkdir(secondBinDir, { recursive: true });
    await fs.writeFile(firstExecutable, "#!/bin/sh\nexit 0\n");
    await fs.writeFile(secondExecutable, "#!/bin/sh\nexit 0\n");
    await fs.chmod(firstExecutable, 0o755);
    await fs.chmod(secondExecutable, 0o755);

    const baseDescriptor = createRegistry()[0];
    if (!baseDescriptor) {
      throw new Error("Expected the test registry to provide a descriptor");
    }

    const descriptor: LspServerDescriptor = {
      ...baseDescriptor,
      launch: {
        type: "manual",
        command: "fake-lsp",
        args: ["--stdio"],
        env: { PATH: prependToPath(firstBinDir) },
      },
    };

    const launchPlans: Array<CreateLspClientOptions["launchPlan"]> = [];
    const closedStates: boolean[] = [];
    const closeMocks: Array<ReturnType<typeof mock>> = [];
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      launchPlans.push(options.launchPlan);
      const clientIndex = closedStates.length;
      closedStates.push(false);
      const close = mock(() => {
        closedStates[clientIndex] = true;
        return Promise.resolve(undefined);
      });
      closeMocks.push(close);
      return Promise.resolve({
        get isClosed() {
          return closedStates[clientIndex] ?? false;
        },
        ensureFile: mock(() => Promise.resolve(1)),
        query: mock(() =>
          Promise.resolve({ operation: "hover" as const, hover: options.launchPlan.command })
        ),
        close,
      });
    });

    const manager = new LspManager({
      registry: [descriptor],
      clientFactory,
    });
    const runtime = new CountingLocalRuntime(workspacePath);

    const first = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    const warmReuse = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    await closeMocks[0]?.();
    descriptor.launch = {
      ...descriptor.launch,
      env: { PATH: prependToPath(secondBinDir) },
    };

    const recreated = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    const recreatedWarmReuse = await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    expect(requireSingleRootQueryResult(first).hover).toBe(firstExecutable);
    expect(requireSingleRootQueryResult(warmReuse).hover).toBe(firstExecutable);
    expect(requireSingleRootQueryResult(recreated).hover).toBe(secondExecutable);
    expect(requireSingleRootQueryResult(recreatedWarmReuse).hover).toBe(secondExecutable);
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(runtime.pathProbeCommands).toHaveLength(2);
    expect(launchPlans).toEqual([
      {
        command: firstExecutable,
        args: ["--stdio"],
        cwd: workspacePath,
        env: { PATH: prependToPath(firstBinDir) },
        initializationOptions: undefined,
      },
      {
        command: secondExecutable,
        args: ["--stdio"],
        cwd: workspacePath,
        env: { PATH: prependToPath(secondBinDir) },
        initializationOptions: undefined,
      },
    ]);

    await manager.dispose();
    expect(closeMocks).toHaveLength(2);
    expect(closeMocks[0]).toHaveBeenCalledTimes(1);
    expect(closeMocks[1]).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent client creation for the same workspace root", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const query = mock(() =>
      Promise.resolve({
        operation: "hover" as const,
        hover: "const value: 1",
      })
    );
    const close = mock(() => Promise.resolve(undefined));
    const client: LspClientInstance = {
      isClosed: false,
      ensureFile,
      query,
      close,
    };
    const clientReady = createDeferred<LspClientInstance>();
    const clientFactoryStarted = createDeferred<void>();
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientFactoryStarted.resolve();
      return clientReady.promise;
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const firstQuery = manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    await clientFactoryStarted.promise;

    const secondQuery = manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(clientFactory).toHaveBeenCalledTimes(1);

    clientReady.resolve(client);
    const [firstResult, secondResult] = await Promise.all([firstQuery, secondQuery]);

    expect(requireSingleRootQueryResult(firstResult).hover).toBe("const value: 1");
    expect(requireSingleRootQueryResult(secondResult).hover).toBe("const value: 1");
    expect(ensureFile).toHaveBeenCalledTimes(2);

    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collects post-mutation diagnostics, clears empty publishes, and clears workspace cache on dispose", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      const diagnostics = version === 1 ? [createDiagnostic("first pass")] : [];
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics,
        rawDiagnosticCount: diagnostics.length,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const first = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.diagnostics[0]?.message).toBe("first pass");

    const second = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    expect(second).toEqual([]);

    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<string, Map<string, Map<string, unknown>>>;
      }
    ).workspaceDiagnostics;
    expect(workspaceDiagnostics.get("ws-1")?.values().next().value?.size ?? 0).toBe(0);

    await manager.disposeWorkspace("ws-1");
    expect(workspaceDiagnostics.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("polls tracked files so out-of-band saves refresh diagnostics even when the cache starts empty", async () => {
    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        text: string;
        version: number;
      }
    >();
    let clientOptions: CreateLspClientOptions | undefined;
    const ensureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const text = await fs.readFile(file.readablePath, "utf8");
      const existing = trackedFiles.get(file.uri);
      const nextVersion = (existing?.version ?? 0) + 1;
      trackedFiles.set(file.uri, {
        fileHandle: { ...file },
        text,
        version: nextVersion,
      });
      if (!existing || existing.text === text) {
        return nextVersion;
      }

      const diagnostics = text.includes('"oops"') ? [createDiagnostic("poll refresh")] : [];
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version: nextVersion,
        diagnostics,
        rawDiagnosticCount: diagnostics.length,
      });
      return nextVersion;
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const snapshots: WorkspaceLspDiagnosticsSnapshot[] = [];
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", (snapshot) => {
      snapshots.push(snapshot);
    });

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);

    await fs.writeFile(
      path.join(workspacePath, "src", "example.ts"),
      'const value: number = "oops";\n'
    );

    const sawPollRefresh = await waitUntil(() => {
      return (
        manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics[0]?.diagnostics[0]?.message ===
        "poll refresh"
      );
    }, 500);
    expect(sawPollRefresh).toBe(true);
    expect(snapshots.at(-1)?.diagnostics[0]?.diagnostics[0]?.message).toBe("poll refresh");

    unsubscribe();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("does not keep tracked workspaces warm when no diagnostics listeners are active", async () => {
    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        version: number;
      }
    >();
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const nextVersion = (trackedFiles.get(file.uri)?.version ?? 0) + 1;
      trackedFiles.set(file.uri, {
        fileHandle: { ...file },
        version: nextVersion,
      });
      return Promise.resolve(nextVersion);
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      idleTimeoutMs: 20,
      idleCheckIntervalMs: 5,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const workspaceClients = (
      manager as unknown as {
        workspaceClients: Map<string, unknown>;
      }
    ).workspaceClients;

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    const disposed = await waitUntil(() => !workspaceClients.has("ws-1"), 200);
    expect(disposed).toBe(true);
    expect(ensureFile).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    await manager.dispose();
  });

  test("clears stale diagnostics and stops polling files that disappear out of band", async () => {
    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        text: string;
        version: number;
      }
    >();
    const ensureFileCalls = new Map<string, number>();
    let clientOptions: CreateLspClientOptions | undefined;
    const ensureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      ensureFileCalls.set(file.uri, (ensureFileCalls.get(file.uri) ?? 0) + 1);

      const text = await fs.readFile(file.readablePath, "utf8");
      const existing = trackedFiles.get(file.uri);
      const nextVersion = existing?.text === text ? existing.version : (existing?.version ?? 0) + 1;
      trackedFiles.set(file.uri, {
        fileHandle: { ...file },
        text,
        version: nextVersion,
      });

      if (existing?.text !== text) {
        const diagnostics = text.includes('"oops"') ? [createDiagnostic("stale diagnostic")] : [];
        clientOptions?.onPublishDiagnostics?.({
          uri: file.uri,
          version: nextVersion,
          diagnostics,
          rawDiagnosticCount: diagnostics.length,
        });
      }

      return nextVersion;
    });
    const closeTrackedFile = mock((uri: string) => {
      trackedFiles.delete(uri);
      return Promise.resolve();
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        closeTrackedFile,
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const filePath = path.join(workspacePath, "src", "example.ts");
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", () => undefined);

    await fs.writeFile(filePath, 'const value: number = "oops";\n');
    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    expect(
      manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics[0]?.diagnostics[0]?.message
    ).toBe("stale diagnostic");

    const trackedFile = trackedFiles.values().next().value?.fileHandle;
    if (!trackedFile) {
      throw new Error("Expected the test client to track the opened file");
    }

    await fs.rm(filePath);

    const staleDiagnosticsCleared = await waitUntil(() => {
      return manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics.length === 0;
    }, 500);
    expect(staleDiagnosticsCleared).toBe(true);
    expect(closeTrackedFile).toHaveBeenCalledTimes(1);

    const ensureCallsAfterCleanup = ensureFileCalls.get(trackedFile.uri) ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ensureFileCalls.get(trackedFile.uri) ?? 0).toBe(ensureCallsAfterCleanup);

    unsubscribe();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("serializes poll-driven and explicit refreshes for the same tracked file", async () => {
    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        text: string;
        version: number;
      }
    >();
    const releaseEnsure = createDeferred<void>();
    const ensureStarted = createDeferred<void>();
    let shouldBlockEnsure = false;
    let blockedEnsureStarted = false;
    let activeEnsureCalls = 0;
    let maxActiveEnsureCalls = 0;
    let clientOptions: CreateLspClientOptions | undefined;
    const ensureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      activeEnsureCalls += 1;
      maxActiveEnsureCalls = Math.max(maxActiveEnsureCalls, activeEnsureCalls);

      try {
        const text = await fs.readFile(file.readablePath, "utf8");
        const existing = trackedFiles.get(file.uri);
        if (shouldBlockEnsure && !blockedEnsureStarted) {
          blockedEnsureStarted = true;
          ensureStarted.resolve();
          await releaseEnsure.promise;
        }

        const nextVersion =
          existing?.text === text ? existing.version : (existing?.version ?? 0) + 1;
        trackedFiles.set(file.uri, {
          fileHandle: { ...file },
          text,
          version: nextVersion,
        });

        if (existing?.text !== text) {
          const diagnostics = text.includes('"oops"')
            ? [createDiagnostic("serialized refresh")]
            : [];
          clientOptions?.onPublishDiagnostics?.({
            uri: file.uri,
            version: nextVersion,
            diagnostics,
            rawDiagnosticCount: diagnostics.length,
          });
        }

        return nextVersion;
      } finally {
        activeEnsureCalls -= 1;
      }
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        closeTrackedFile: mock((uri: string) => {
          trackedFiles.delete(uri);
          return Promise.resolve();
        }),
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const filePath = path.join(workspacePath, "src", "example.ts");
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", () => undefined);

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    await fs.writeFile(filePath, 'const value: number = "oops";\n');

    shouldBlockEnsure = true;
    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 200,
    });

    await ensureStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(maxActiveEnsureCalls).toBe(1);

    shouldBlockEnsure = false;
    releaseEnsure.resolve();

    const diagnostics = await diagnosticsPromise;
    expect(maxActiveEnsureCalls).toBe(1);
    expect(diagnostics[0]?.diagnostics[0]?.message).toBe("serialized refresh");

    unsubscribe();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("idle cleanup does not dispose a workspace while a poll refresh is active", async () => {
    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        version: number;
      }
    >();
    const releaseEnsure = createDeferred<void>();
    const ensureStarted = createDeferred<void>();
    let shouldBlockEnsure = false;
    let blockedEnsureStarted = false;
    const ensureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const existing = trackedFiles.get(file.uri);
      if (shouldBlockEnsure && existing && !blockedEnsureStarted) {
        blockedEnsureStarted = true;
        ensureStarted.resolve();
        await releaseEnsure.promise;
      }

      const nextVersion = (existing?.version ?? 0) + 1;
      trackedFiles.set(file.uri, {
        fileHandle: { ...file },
        version: nextVersion,
      });
      return nextVersion;
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      idleTimeoutMs: 20,
      idleCheckIntervalMs: 5,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", () => undefined);
    const workspaceClients = (
      manager as unknown as {
        workspaceClients: Map<string, unknown>;
      }
    ).workspaceClients;

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    shouldBlockEnsure = true;
    await ensureStarted.promise;
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(close).toHaveBeenCalledTimes(0);
    expect(workspaceClients.has("ws-1")).toBe(true);

    releaseEnsure.resolve();
    unsubscribe();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("disposeWorkspace clears poll bookkeeping before recreating the workspace", async () => {
    const firstTrackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        version: number;
      }
    >();
    const secondTrackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        version: number;
      }
    >();
    const releaseFirstPoll = createDeferred<void>();
    const firstPollStarted = createDeferred<void>();
    let shouldBlockFirstPoll = false;
    let firstPollBlocked = false;
    let secondEnsureCalls = 0;
    const firstEnsureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const existing = firstTrackedFiles.get(file.uri);
      if (shouldBlockFirstPoll && existing && !firstPollBlocked) {
        firstPollBlocked = true;
        firstPollStarted.resolve();
        await releaseFirstPoll.promise;
      }

      const nextVersion = (existing?.version ?? 0) + 1;
      firstTrackedFiles.set(file.uri, {
        fileHandle: { ...file },
        version: nextVersion,
      });
      return nextVersion;
    });
    const secondEnsureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      secondEnsureCalls += 1;
      const existing = secondTrackedFiles.get(file.uri);
      const nextVersion = (existing?.version ?? 0) + 1;
      secondTrackedFiles.set(file.uri, {
        fileHandle: { ...file },
        version: nextVersion,
      });
      return Promise.resolve(nextVersion);
    });
    const firstClose = mock(() => Promise.resolve(undefined));
    const secondClose = mock(() => Promise.resolve(undefined));
    let clientCount = 0;
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientCount += 1;
      if (clientCount === 1) {
        return Promise.resolve({
          isClosed: false,
          ensureFile: firstEnsureFile,
          getTrackedFiles: () =>
            [...firstTrackedFiles.values()].map(({ fileHandle }) => ({
              ...fileHandle,
            })),
          query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
          close: firstClose,
        });
      }

      if (clientCount === 2) {
        return Promise.resolve({
          isClosed: false,
          ensureFile: secondEnsureFile,
          getTrackedFiles: () =>
            [...secondTrackedFiles.values()].map(({ fileHandle }) => ({
              ...fileHandle,
            })),
          query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
          close: secondClose,
        });
      }

      throw new Error(`Unexpected client creation #${clientCount}`);
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", () => undefined);
    const managerWithInternals = manager as unknown as {
      diagnosticPollsInFlight: Map<string, symbol>;
      trackedFileRefreshesInFlight: Map<string, Promise<unknown>>;
    };

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    shouldBlockFirstPoll = true;
    await firstPollStarted.promise;

    expect(
      [...managerWithInternals.diagnosticPollsInFlight.keys()].some((key) =>
        key.startsWith("ws-1:")
      )
    ).toBe(true);
    expect(
      [...managerWithInternals.trackedFileRefreshesInFlight.keys()].some((key) =>
        key.startsWith("ws-1:")
      )
    ).toBe(true);

    await manager.disposeWorkspace("ws-1");

    expect(
      [...managerWithInternals.diagnosticPollsInFlight.keys()].some((key) =>
        key.startsWith("ws-1:")
      )
    ).toBe(false);
    expect(
      [...managerWithInternals.trackedFileRefreshesInFlight.keys()].some((key) =>
        key.startsWith("ws-1:")
      )
    ).toBe(false);

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    const pollRestarted = await waitUntil(() => secondEnsureCalls >= 2, 200);
    expect(pollRestarted).toBe(true);

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    const completion = await Promise.race([
      diagnosticsPromise.then((diagnostics) => ({ type: "resolved" as const, diagnostics })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 200);
      }),
    ]);
    expect(completion.type).toBe("resolved");
    if (completion.type !== "resolved") {
      throw new Error("Expected recreated workspace refreshes to ignore stale in-flight state");
    }
    expect(completion.diagnostics).toEqual([]);

    releaseFirstPoll.resolve();
    unsubscribe();
    await manager.dispose();
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).toHaveBeenCalledTimes(1);
  });

  test("continues polling other tracked files after one file disappears", async () => {
    const secondFilePath = path.join(workspacePath, "src", "second.ts");
    await fs.writeFile(secondFilePath, "export const second = 1;\n");

    const trackedFiles = new Map<
      string,
      {
        fileHandle: Parameters<LspClientInstance["ensureFile"]>[0];
        text: string;
        version: number;
      }
    >();
    let clientOptions: CreateLspClientOptions | undefined;
    const ensureFile = mock(async (file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const text = await fs.readFile(file.readablePath, "utf8");
      const existing = trackedFiles.get(file.uri);
      const nextVersion = (existing?.version ?? 0) + 1;
      trackedFiles.set(file.uri, {
        fileHandle: { ...file },
        text,
        version: nextVersion,
      });
      if (!existing || existing.text === text) {
        return nextVersion;
      }

      const diagnostics = text.includes('"oops"') ? [createDiagnostic("second file refresh")] : [];
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version: nextVersion,
        diagnostics,
        rawDiagnosticCount: diagnostics.length,
      });
      return nextVersion;
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        getTrackedFiles: () =>
          [...trackedFiles.values()].map(({ fileHandle }) => ({
            ...fileHandle,
          })),
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
      diagnosticPollIntervalMs: 10,
    });
    const runtime = new LocalRuntime(workspacePath);
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", () => undefined);

    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/example.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });
    await manager.query({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePath: "src/second.ts",
      policyContext: TEST_LSP_POLICY_CONTEXT,
      operation: "hover",
      line: 1,
      column: 1,
    });

    await fs.rm(path.join(workspacePath, "src", "example.ts"));
    await fs.writeFile(secondFilePath, 'const second: number = "oops";\n');

    const sawHealthyRefresh = await waitUntil(() => {
      return (
        manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics[0]?.diagnostics[0]?.message ===
        "second file refresh"
      );
    }, 500);
    expect(sawHealthyRefresh).toBe(true);

    unsubscribe();
    await manager.dispose();
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("ignores malformed publishes so they do not clear cached diagnostics or satisfy waits", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics: version === 1 ? [createDiagnostic("first pass")] : [],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const first = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    expect(first).toHaveLength(1);
    expect(first[0]?.diagnostics[0]?.message).toBe("first pass");

    const second = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    expect(second).toEqual([]);

    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<
          string,
          Map<string, Map<string, { diagnostics: LspDiagnostic[] }>>
        >;
      }
    ).workspaceDiagnostics;
    const cachedDiagnostics = [
      ...(workspaceDiagnostics.get("ws-1")?.values().next().value?.values() ?? []),
    ];
    expect(cachedDiagnostics).toHaveLength(1);
    expect(cachedDiagnostics[0]?.diagnostics[0]?.message).toBe("first pass");

    await manager.disposeWorkspace("ws-1");
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collects post-mutation diagnostics across roots without serial waits", async () => {
    const secondEnsureStarted = createDeferred<void>();
    const publishByUri = new Map<string, () => void>();
    let secondEnsureResolved = false;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        publishByUri.set(file.uri, () => {
          options.onPublishDiagnostics?.({
            uri: file.uri,
            version: 1,
            diagnostics: [createDiagnostic(`diagnostic for ${file.uri}`)],
            rawDiagnosticCount: 1,
          });
        });
        if (publishByUri.size === 2 && !secondEnsureResolved) {
          secondEnsureResolved = true;
          secondEnsureStarted.resolve();
        }
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 200,
    });

    await Promise.race([
      secondEnsureStarted.promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () =>
            reject(new Error("Expected both files to start waiting before diagnostics publish")),
          50
        );
      }),
    ]);

    for (const publish of publishByUri.values()) {
      publish();
    }

    const diagnostics = await diagnosticsPromise;
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
  });

  test("keeps diagnostics isolated by root uri within the same workspace", async () => {
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        options.onPublishDiagnostics?.({
          uri: file.uri,
          version: 1,
          diagnostics: [createDiagnostic(`diagnostic for ${options.rootPath}`)],
          rawDiagnosticCount: 1,
        });
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnostics = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });

    expect(diagnostics).toHaveLength(2);
    expect(new Set(diagnostics.map((entry) => entry.rootUri)).size).toBe(2);
    expect(diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
  });

  test("returns cloned sorted snapshots and notifies listeners on publish and clear", async () => {
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
        options.onPublishDiagnostics?.({
          uri: file.uri,
          version: 1,
          diagnostics: [createDiagnostic(`diagnostic for ${file.runtimePath}`)],
          rawDiagnosticCount: 1,
        });
        return Promise.resolve(1);
      });

      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close: mock(() => Promise.resolve(undefined)),
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);
    const snapshots: WorkspaceLspDiagnosticsSnapshot[] = [];
    const unsubscribe = manager.subscribeWorkspaceDiagnostics("ws-1", (snapshot) => {
      snapshots.push(snapshot);
    });

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts", "packages/pkg/src/nested.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });

    const snapshot = manager.getWorkspaceDiagnosticsSnapshot("ws-1");
    expect(snapshot.diagnostics.map((entry) => entry.path)).toEqual([
      path.join(workspacePath, "packages", "pkg", "src", "nested.ts"),
      path.join(workspacePath, "src", "example.ts"),
    ]);
    const firstDiagnostic = snapshot.diagnostics[0];
    expect(firstDiagnostic).toBeDefined();
    if (!firstDiagnostic) {
      throw new Error("Expected the first diagnostics entry to exist");
    }
    const firstMessage = firstDiagnostic.diagnostics[0];
    expect(firstMessage).toBeDefined();
    if (!firstMessage) {
      throw new Error("Expected the first diagnostic message to exist");
    }
    firstMessage.message = "mutated";
    const refreshedSnapshot = manager.getWorkspaceDiagnosticsSnapshot("ws-1");
    expect(refreshedSnapshot.diagnostics[0]?.diagnostics[0]?.message).toBe(
      `diagnostic for ${path.join(workspacePath, "packages", "pkg", "src", "nested.ts")}`
    );

    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.diagnostics).toHaveLength(1);
    expect(snapshots[1]?.diagnostics).toHaveLength(2);

    await manager.disposeWorkspace("ws-1");
    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);
    expect(snapshots.at(-1)?.diagnostics).toEqual([]);

    unsubscribe();
  });

  test("ignores late diagnostics publishes from disposed clients", async () => {
    let clientOptions: CreateLspClientOptions | undefined;
    let ensuredFile: Parameters<LspClientInstance["ensureFile"]>[0] | undefined;
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      ensuredFile = file;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version: 1,
        diagnostics: [createDiagnostic("first pass")],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(1);
    });
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnostics = await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });
    expect(diagnostics).toHaveLength(1);

    await manager.disposeWorkspace("ws-1");
    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);

    if (!clientOptions || !ensuredFile) {
      throw new Error("Expected the LSP client to publish diagnostics for the test file");
    }

    clientOptions.onPublishDiagnostics?.({
      uri: ensuredFile.uri,
      version: 2,
      diagnostics: [createDiagnostic("late publish")],
      rawDiagnosticCount: 1,
    });

    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toEqual([]);
    const workspaceDiagnostics = (
      manager as unknown as {
        workspaceDiagnostics: Map<string, Map<string, Map<string, unknown>>>;
      }
    ).workspaceDiagnostics;
    expect(workspaceDiagnostics.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("collectPostMutationDiagnostics exits promptly when disposal wins before waiter registration", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);
    const managerWithInternals = manager as unknown as {
      diagnosticWaiters: Map<string, Map<string, Map<string, Set<unknown>>>>;
      waitForFreshDiagnostics: (params: {
        workspaceId: string;
        workspaceGeneration: number;
        clientKey: string;
        uri: string;
        previousReceivedAtMs?: number;
        expectedVersion: number;
        timeoutMs: number;
      }) => Promise<unknown>;
    };
    const originalWaitForFreshDiagnostics =
      managerWithInternals.waitForFreshDiagnostics.bind(managerWithInternals);
    managerWithInternals.waitForFreshDiagnostics = async (params) => {
      await manager.disposeWorkspace("ws-1");
      return await originalWaitForFreshDiagnostics(params);
    };

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 10_000,
    });

    const completion = await Promise.race([
      diagnosticsPromise.then((diagnostics) => ({ type: "resolved" as const, diagnostics })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 200);
      }),
    ]);
    expect(completion.type).toBe("resolved");
    if (completion.type !== "resolved") {
      throw new Error("Expected diagnostics collection to resolve after workspace disposal");
    }
    expect(completion.diagnostics).toEqual([]);
    expect(managerWithInternals.diagnosticWaiters.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("disposeWorkspace settles pending diagnostics waits promptly", async () => {
    const ensureFile = mock(() => Promise.resolve(1));
    const close = mock(() => Promise.resolve(undefined));
    const clientFactory = mock((_options: CreateLspClientOptions): Promise<LspClientInstance> => {
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    const diagnosticsPromise = manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 10_000,
    });

    const diagnosticWaiters = (
      manager as unknown as {
        diagnosticWaiters: Map<string, Map<string, Map<string, Set<unknown>>>>;
      }
    ).diagnosticWaiters;
    const waiterRegistered = await waitUntil(() => {
      const workspaceWaiters = diagnosticWaiters.get("ws-1");
      if (!workspaceWaiters) {
        return false;
      }
      for (const clientWaiters of workspaceWaiters.values()) {
        for (const waiters of clientWaiters.values()) {
          if (waiters.size > 0) {
            return true;
          }
        }
      }
      return false;
    });
    expect(waiterRegistered).toBe(true);

    await manager.disposeWorkspace("ws-1");

    const completion = await Promise.race([
      diagnosticsPromise.then((diagnostics) => ({ type: "resolved" as const, diagnostics })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), 200);
      }),
    ]);
    expect(completion.type).toBe("resolved");
    if (completion.type !== "resolved") {
      throw new Error("Expected diagnostics wait to resolve after workspace disposal");
    }
    expect(completion.diagnostics).toEqual([]);
    expect(diagnosticWaiters.has("ws-1")).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test("ignores malformed publishes in workspace snapshots", async () => {
    const ensureFile = mock((file: Parameters<LspClientInstance["ensureFile"]>[0]) => {
      const version = ensureFile.mock.calls.length;
      clientOptions?.onPublishDiagnostics?.({
        uri: file.uri,
        version,
        diagnostics: version === 1 ? [createDiagnostic("first pass")] : [],
        rawDiagnosticCount: 1,
      });
      return Promise.resolve(version);
    });
    const close = mock(() => Promise.resolve(undefined));
    let clientOptions: CreateLspClientOptions | undefined;
    const clientFactory = mock((options: CreateLspClientOptions): Promise<LspClientInstance> => {
      clientOptions = options;
      return Promise.resolve({
        isClosed: false,
        ensureFile,
        query: mock(() => Promise.resolve({ operation: "hover" as const, hover: "unused" })),
        close,
      });
    });

    const manager = new LspManager({
      registry: createRegistry(),
      clientFactory,
    });
    const runtime = new LocalRuntime(workspacePath);

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });

    await manager.collectPostMutationDiagnostics({
      workspaceId: "ws-1",
      runtime,
      workspacePath,
      filePaths: ["src/example.ts"],
      policyContext: TEST_LSP_POLICY_CONTEXT,
      timeoutMs: 20,
    });

    expect(manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics).toHaveLength(1);
    expect(
      manager.getWorkspaceDiagnosticsSnapshot("ws-1").diagnostics[0]?.diagnostics[0]?.message
    ).toBe("first pass");

    await manager.disposeWorkspace("ws-1");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
