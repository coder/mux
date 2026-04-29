import { readFileString } from "@/node/utils/runtime/helpers";
import { shellQuote } from "@/common/utils/shell";
import { LSP_REQUEST_TIMEOUT_MS, LSP_START_TIMEOUT_MS } from "@/constants/lsp";
import { log } from "@/node/services/log";
import { LspStdioTransport, type LspJsonRpcMessage } from "./lspStdioTransport";
import type {
  CreateLspClientOptions,
  LspClientFileHandle,
  LspClientInstance,
  LspClientQueryRequest,
  LspClientQueryResult,
  LspDiagnostic,
  LspDocumentSymbol,
  LspHover,
  LspLocation,
  LspLocationLink,
  LspMarkedString,
  LspMarkupContent,
  LspPublishDiagnosticsParams,
  LspSymbolInformation,
} from "./types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface OpenDocumentState {
  file: LspClientFileHandle;
  version: number;
  text: string;
}

interface InitializeResult {
  capabilities?: Record<string, unknown>;
}

export class LspClient implements LspClientInstance {
  private readonly transport: LspStdioTransport;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly openDocuments = new Map<string, OpenDocumentState>();
  private nextRequestId = 1;
  private initialized = false;
  isClosed = false;

  private constructor(
    private readonly options: CreateLspClientOptions,
    transport: LspStdioTransport
  ) {
    this.transport = transport;
    this.transport.onmessage = (message) => this.handleMessage(message);
    this.transport.onclose = () => this.handleClose();
    this.transport.onerror = (error) => this.handleTransportError(error);
  }

  static async create(options: CreateLspClientOptions): Promise<LspClient> {
    const command = [
      shellQuote(options.launchPlan.command),
      ...options.launchPlan.args.map((arg) => shellQuote(arg)),
    ].join(" ");
    const execStream = await options.runtime.exec(command, {
      cwd: options.launchPlan.cwd ?? options.rootPath,
      ...(options.launchPlan.env ? { env: { ...options.launchPlan.env } } : {}),
      // LSP servers are long-lived by design; timeout would kill healthy clients mid-session.
    });

    const transport = new LspStdioTransport(execStream);
    const client = new LspClient(options, transport);
    await client.start();
    return client;
  }

  async ensureFile(file: LspClientFileHandle): Promise<number> {
    this.ensureStarted();

    const text = await readFileString(this.options.runtime, file.readablePath);
    const existingState = this.openDocuments.get(file.uri);

    if (!existingState) {
      this.openDocuments.set(file.uri, {
        file: { ...file },
        version: 1,
        text,
      });
      await this.notify("textDocument/didOpen", {
        textDocument: {
          uri: file.uri,
          languageId: file.languageId,
          version: 1,
          text,
        },
      });
      return 1;
    }

    if (existingState.text === text) {
      existingState.file = { ...file };
      return existingState.version;
    }

    const nextVersion = existingState.version + 1;
    this.openDocuments.set(file.uri, {
      file: { ...file },
      version: nextVersion,
      text,
    });
    await this.notify("textDocument/didChange", {
      textDocument: {
        uri: file.uri,
        version: nextVersion,
      },
      contentChanges: [{ text }],
    });
    return nextVersion;
  }

  async closeTrackedFile(uri: string): Promise<void> {
    const existingState = this.openDocuments.get(uri);
    if (!existingState) {
      return;
    }

    this.openDocuments.delete(uri);
    if (!this.initialized || this.isClosed || this.transport.isClosed()) {
      return;
    }

    await this.notify("textDocument/didClose", {
      textDocument: {
        uri: existingState.file.uri,
      },
    });
  }

  getTrackedFiles(): readonly LspClientFileHandle[] {
    return [...this.openDocuments.values()].map(({ file }) => ({ ...file }));
  }

  async query(request: LspClientQueryRequest): Promise<LspClientQueryResult> {
    this.ensureStarted();

    switch (request.operation) {
      case "hover": {
        const result = (await this.request(
          "textDocument/hover",
          this.createTextDocumentPositionParams(request),
          LSP_REQUEST_TIMEOUT_MS
        )) as LspHover | null;
        return {
          operation: request.operation,
          hover: result ? normalizeHoverContents(result.contents) : "",
        };
      }
      case "definition": {
        const result = (await this.request(
          "textDocument/definition",
          this.createTextDocumentPositionParams(request),
          LSP_REQUEST_TIMEOUT_MS
        )) as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null;
        return {
          operation: request.operation,
          locations: normalizeLocations(result),
        };
      }
      case "references": {
        const result = (await this.request(
          "textDocument/references",
          {
            ...this.createTextDocumentPositionParams(request),
            context: {
              includeDeclaration: request.includeDeclaration === true,
            },
          },
          LSP_REQUEST_TIMEOUT_MS
        )) as LspLocation[] | null;
        return {
          operation: request.operation,
          locations: normalizeLocations(result),
        };
      }
      case "implementation": {
        const result = (await this.request(
          "textDocument/implementation",
          this.createTextDocumentPositionParams(request),
          LSP_REQUEST_TIMEOUT_MS
        )) as LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null;
        return {
          operation: request.operation,
          locations: normalizeLocations(result),
        };
      }
      case "document_symbols": {
        const file = this.getRequiredFile(request);
        const result = (await this.request(
          "textDocument/documentSymbol",
          {
            textDocument: {
              uri: file.uri,
            },
          },
          LSP_REQUEST_TIMEOUT_MS
        )) as Array<LspDocumentSymbol | LspSymbolInformation> | null;
        return {
          operation: request.operation,
          symbols: result ?? [],
        };
      }
      case "workspace_symbols": {
        const result = (await this.request(
          "workspace/symbol",
          {
            query: request.query ?? "",
          },
          LSP_REQUEST_TIMEOUT_MS
        )) as Array<LspDocumentSymbol | LspSymbolInformation> | null;
        return {
          operation: request.operation,
          symbols: result ?? [],
        };
      }
    }
  }

  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    try {
      if (this.initialized) {
        await this.request("shutdown", undefined, 3000);
        await this.notify("exit");
      }
    } catch (error) {
      log.debug("Failed to shut down LSP client cleanly", {
        serverId: this.options.descriptor.id,
        error,
      });
    } finally {
      this.isClosed = true;
      await this.transport.close();
    }
  }

  private async start(): Promise<void> {
    this.transport.start();
    const response = (await this.request(
      "initialize",
      {
        processId: process.pid,
        rootUri: this.options.rootUri,
        rootPath: this.options.rootPath,
        workspaceFolders: [
          {
            uri: this.options.rootUri,
            name: this.options.descriptor.id,
          },
        ],
        capabilities: {
          workspace: {
            workspaceFolders: true,
          },
          textDocument: {
            hover: {
              contentFormat: ["markdown", "plaintext"],
            },
            definition: {
              linkSupport: true,
            },
            implementation: {
              linkSupport: true,
            },
            references: {},
            documentSymbol: {
              hierarchicalDocumentSymbolSupport: true,
            },
          },
        },
        ...(this.options.launchPlan.initializationOptions !== undefined
          ? { initializationOptions: this.options.launchPlan.initializationOptions }
          : {}),
      },
      LSP_START_TIMEOUT_MS
    )) as InitializeResult;

    this.initialized = true;
    await this.notify("initialized", {});

    log.debug("Started LSP client", {
      serverId: this.options.descriptor.id,
      rootUri: this.options.rootUri,
      capabilities: response.capabilities ? Object.keys(response.capabilities) : [],
    });
  }

  private ensureStarted(): void {
    if (!this.initialized) {
      throw new Error(`LSP client for ${this.options.descriptor.id} is not initialized`);
    }
    if (this.isClosed || this.transport.isClosed()) {
      throw new Error(
        `LSP client for ${this.options.descriptor.id} is closed${this.buildStderrSuffix()}`
      );
    }
  }

  private createTextDocumentPositionParams(request: LspClientQueryRequest) {
    if (request.line == null || request.character == null) {
      throw new Error(`${request.operation} requires a line and column`);
    }

    const file = this.getRequiredFile(request);
    return {
      textDocument: {
        uri: file.uri,
      },
      position: {
        line: request.line,
        character: request.character,
      },
    };
  }

  private getRequiredFile(request: LspClientQueryRequest): LspClientFileHandle {
    if (!request.file) {
      throw new Error(`${request.operation} requires a file path`);
    }

    return request.file;
  }

  private async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.isClosed || this.transport.isClosed()) {
      throw new Error(
        `Cannot send ${method} to closed LSP client (${this.options.descriptor.id})${this.buildStderrSuffix()}`
      );
    }

    const requestId = this.nextRequestId++;

    return await new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `LSP request timed out: ${this.options.descriptor.id} ${method}${this.buildStderrSuffix()}`
          )
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeoutId,
      });

      void this.transport
        .send({
          jsonrpc: "2.0",
          id: requestId,
          method,
          ...(params !== undefined ? { params } : {}),
        })
        .catch((error) => {
          const pending = this.pendingRequests.get(requestId);
          if (!pending) {
            return;
          }

          clearTimeout(pending.timeoutId);
          this.pendingRequests.delete(requestId);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    if (this.isClosed || this.transport.isClosed()) {
      return;
    }

    await this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  private handleMessage(message: LspJsonRpcMessage): void {
    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timeoutId);
      this.pendingRequests.delete(message.id);

      if (message.error) {
        pending.reject(
          new Error(
            `LSP ${this.options.descriptor.id} request failed: ${message.error.message}${this.buildStderrSuffix()}`
          )
        );
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method === "textDocument/publishDiagnostics") {
      const params = parsePublishDiagnosticsParams(message.params);
      if (params) {
        this.options.onPublishDiagnostics?.(params);
      }
    }
  }

  private handleClose(): void {
    this.isClosed = true;
    const error = new Error(
      `LSP client for ${this.options.descriptor.id} closed unexpectedly${this.buildStderrSuffix()}`
    );
    this.rejectAllPending(error);
  }

  private handleTransportError(error: Error): void {
    this.isClosed = true;
    this.rejectAllPending(
      new Error(
        `LSP transport error for ${this.options.descriptor.id}: ${error.message}${this.buildStderrSuffix()}`
      )
    );
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  private buildStderrSuffix(): string {
    const stderrTail = this.transport.getStderrTail();
    return stderrTail.length > 0 ? `; stderr: ${stderrTail}` : "";
  }
}

function parsePublishDiagnosticsParams(params: unknown): LspPublishDiagnosticsParams | null {
  if (typeof params !== "object" || params == null || Array.isArray(params)) {
    return null;
  }

  const record = params as Record<string, unknown>;
  if (typeof record.uri !== "string" || !Array.isArray(record.diagnostics)) {
    return null;
  }

  const diagnostics = record.diagnostics
    .map((diagnostic) => parseDiagnostic(diagnostic))
    .filter((diagnostic): diagnostic is LspDiagnostic => diagnostic !== null);

  return {
    uri: record.uri,
    version: typeof record.version === "number" ? record.version : undefined,
    diagnostics,
    rawDiagnosticCount: record.diagnostics.length,
  };
}

function parseDiagnostic(value: unknown): LspDiagnostic | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const range = parseRange(record.range);
  if (!range || typeof record.message !== "string") {
    return null;
  }

  const severity =
    typeof record.severity === "number" && record.severity >= 1 && record.severity <= 4
      ? (record.severity as 1 | 2 | 3 | 4)
      : undefined;
  const code =
    typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined;

  return {
    range,
    message: record.message,
    severity,
    code,
    source: typeof record.source === "string" ? record.source : undefined,
  };
}

function parseRange(value: unknown): LspLocation["range"] | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const start = parsePosition(record.start);
  const end = parsePosition(record.end);
  if (!start || !end) {
    return null;
  }

  return { start, end };
}

function parsePosition(value: unknown): LspLocation["range"]["start"] | null {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.line !== "number" || typeof record.character !== "number") {
    return null;
  }

  return {
    line: record.line,
    character: record.character,
  };
}

function normalizeLocations(
  value: LspLocation | LspLocationLink | Array<LspLocation | LspLocationLink> | null | undefined
): LspLocation[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) => {
    if ("targetUri" in entry) {
      return {
        uri: entry.targetUri,
        range: entry.targetRange,
      };
    }

    return entry;
  });
}

function normalizeHoverContents(contents: LspHover["contents"]): string {
  if (typeof contents === "string") {
    return contents;
  }

  if (Array.isArray(contents)) {
    return contents
      .map((entry) => normalizeHoverContents(entry))
      .filter((entry) => entry.length > 0)
      .join("\n\n");
  }

  if (isMarkupContent(contents)) {
    return contents.value;
  }

  return contents.value;
}

function isMarkupContent(value: LspMarkupContent | LspMarkedString): value is LspMarkupContent {
  return "kind" in value;
}
